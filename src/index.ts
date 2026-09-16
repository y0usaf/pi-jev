import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	askJev,
	describeAnswer,
	JevError,
	redact,
	rememberSecret,
	type JevQuestion,
	type JevResponse,
} from "./client";
import {
	API_KEY_ENV,
	loadJevConfig,
	type JevConfig,
	type LoadedJevConfig,
} from "./config";
import {
	buildGateState,
	describeAnswers,
	evaluateGate,
	GATE_QUESTIONS,
	judgmentKey,
	summarizeVerdict,
	type GateVerdict,
} from "./gate";

/**
 * pi-jev - TypeSafe Jev as a decision layer for pi.
 *
 * Two jobs, both decided by typed questions rather than by prompt text:
 *
 *   1. Gate. Before a mutating tool runs, ask Jev whether the action is
 *      destructive, exfiltrating, or outside scope, plus how reversible it is.
 *      Shadow mode (default) reports. Enforce mode asks the user to confirm.
 *   2. jev_ask. A model-facing tool for decisions that should be typed and
 *      calibrated instead of written: classification, relevance, yes/no checks.
 *
 * Fails open. An API outage must never stop the agent from working, so every
 * error path returns "no verdict" instead of a block.
 */

const STATUS_KEY = "jev";
const ERROR_NOTIFY_INTERVAL_MS = 60_000;

const QuestionParam = Type.Object({
	id: Type.String({
		description: "Short key for this question. The answer comes back under it.",
	}),
	type: StringEnum(["noul", "choice", "score"] as const, {
		description:
			"noul = yes/no probability, choice = pick one option, score = value on a rubric",
	}),
	instructions: Type.String({
		description:
			"The one thing to judge. One specific, well-scoped gut-check per question.",
	}),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Option key" }),
				description: Type.Optional(
					Type.String({ description: "When this option applies" }),
				),
			}),
			{ description: "choice only: the options to choose between" },
		),
	),
	levels: Type.Optional(
		Type.Array(Type.String(), {
			description: "score only: ordered rubric levels, lowest first, at least two",
		}),
	),
});

const AskParams = Type.Object({
	state: Type.String({
		description:
			"The text to judge: tool output, a diff, a message, a document excerpt.",
	}),
	questions: Type.Array(QuestionParam, {
		description:
			"One or more questions. All are evaluated in parallel against the same state.",
	}),
});

export default function jevExtension(pi: ExtensionAPI): void {
	let loaded: LoadedJevConfig = loadJevConfig(process.cwd());
	let config: JevConfig = loaded.config;
	rememberSecret(config.apiKey);

	let enabled = config.gate.enabled;
	let mode = config.gate.mode;

	const cache = new Map<string, { at: number; verdict: GateVerdict }>();
	const inflight = new Map<string, Promise<GateVerdict | undefined>>();
	let last: { tool: string; verdict: GateVerdict; at: number } | undefined;
	let lastErrorAt = 0;
	let missingKeyWarned = false;

	function reload(cwd: string): void {
		loaded = loadJevConfig(cwd);
		config = loaded.config;
		rememberSecret(config.apiKey);
		enabled = config.gate.enabled;
		mode = config.gate.mode;
	}

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx.cwd);
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-jev: ${redact(warning)}`, "warning");
		}
		if (!config.apiKey) {
			if (!missingKeyWarned) {
				missingKeyWarned = true;
				ctx.ui.notify(
					`pi-jev: no key. Set ${API_KEY_ENV} or apiKeyFile in pi-jev.json; the gate is inactive until then.`,
					"warning",
				);
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			`jev: ${enabled ? mode : "off"}`,
		);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || !config.apiKey) return;
		if (!config.gate.tools.includes(event.toolName)) return;

		const key = judgmentKey(event.toolName, event.input);
		const verdict = await verdictFor(key, event, ctx);
		if (!verdict) return;

		last = { tool: event.toolName, verdict, at: Date.now() };
		ctx.ui.setStatus(
			STATUS_KEY,
			verdict.flagged
				? `jev: ${summarizeVerdict(verdict)}`
				: `jev: clear (${mode})`,
		);
		if (!verdict.flagged) return;

		const reason = `pi-jev: ${summarizeVerdict(verdict)}`;
		if (mode === "shadow") {
			ctx.ui.notify(
				`jev shadow: ${event.toolName} - ${summarizeVerdict(verdict)}`,
				"warning",
			);
			return;
		}

		if (!ctx.hasUI) {
			if (config.gate.blockWithoutUI) return { block: true, reason };
			// No UI means no way to approve a flagged call. Degrade to shadow
			// rather than deadlocking a headless run on a classifier's opinion.
			ctx.ui.notify(
				`jev: ${event.toolName} - ${summarizeVerdict(verdict)} (headless: not blocking; set gate.blockWithoutUI to block)`,
				"warning",
			);
			return;
		}
		const allow = await ctx.ui.confirm(
			"Jev flagged this tool call",
			`${event.toolName}\n${summarizeVerdict(verdict)}\n\nRun it anyway?`,
		);
		return allow ? undefined : { block: true, reason: `${reason} (declined)` };
	});

	async function verdictFor(
		key: string,
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<GateVerdict | undefined> {
		const cached = cache.get(key);
		if (
			cached &&
			(Date.now() - cached.at) / 1000 <= config.gate.cacheSeconds
		) {
			return cached.verdict;
		}
		const pending = inflight.get(key);
		if (pending) return pending;

		const promise = judge(event, ctx).finally(() => inflight.delete(key));
		inflight.set(key, promise);
		const verdict = await promise;
		if (verdict) {
			cache.set(key, { at: Date.now(), verdict });
			prune();
		}
		return verdict;
	}

	async function judge(
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<GateVerdict | undefined> {
		const apiKey = config.apiKey;
		if (!apiKey) return undefined;
		try {
			const response = await askJev({
				state: buildGateState({
					cwd: ctx.cwd,
					toolName: event.toolName,
					input: event.input,
					userRequest: lastUserRequest(ctx),
					maxStateChars: config.maxStateChars,
					argumentChars: config.gate.argumentChars,
				}),
				questions: GATE_QUESTIONS,
				apiKey,
				model: config.model,
				endpoint: config.endpoint,
				timeoutMs: config.timeoutMs,
				retries: config.retries,
				signal: ctx.signal,
			});
			return evaluateGate(response, config);
		} catch (error) {
			notifyError(ctx, error);
			return undefined;
		}
	}

	function notifyError(ctx: ExtensionContext, error: unknown): void {
		const at = Date.now();
		if (at - lastErrorAt < ERROR_NOTIFY_INTERVAL_MS) return;
		lastErrorAt = at;
		ctx.ui.notify(
			`pi-jev: ${redact(error instanceof Error ? error.message : String(error))} (failing open)`,
			"error",
		);
	}

	function prune(): void {
		if (cache.size <= 64) return;
		const cutoff = Date.now() - config.gate.cacheSeconds * 1000;
		for (const [key, entry] of cache) {
			if (entry.at < cutoff) cache.delete(key);
		}
		while (cache.size > 64) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	pi.registerCommand("jev", {
		description: "TypeSafe Jev gate: status, mode, on/off, last verdict",
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().toLowerCase().split(/\s+/);
			if (sub === "on" || sub === "off") {
				enabled = sub === "on";
				ctx.ui.setStatus(STATUS_KEY, enabled ? `jev: ${mode}` : "jev: off");
				ctx.ui.notify(`pi-jev: gate ${sub}`, "info");
				return;
			}
			if (sub === "mode") {
				if (value !== "shadow" && value !== "enforce") {
					ctx.ui.notify(
						`pi-jev: mode is ${mode} (usage: /jev mode shadow|enforce)`,
						"warning",
					);
					return;
				}
				mode = value;
				ctx.ui.setStatus(STATUS_KEY, `jev: ${enabled ? mode : "off"}`);
				ctx.ui.notify(
					`pi-jev: ${mode}${mode === "shadow" ? " (reports, never blocks)" : " (asks before running flagged calls)"}`,
					"info",
				);
				return;
			}
			if (sub === "last") {
				if (!last) {
					ctx.ui.notify("pi-jev: no verdicts yet", "info");
					return;
				}
				ctx.ui.notify(
					`pi-jev: ${last.tool} - ${summarizeVerdict(last.verdict)} | ${describeAnswers({ model: last.verdict.model, answers: last.verdict.answers })}`,
					"info",
				);
				return;
			}
			if (sub === "check") {
				const text = args.trim().slice("check".length).trim();
				if (!text) {
					ctx.ui.notify("pi-jev: usage /jev check <text>", "warning");
					return;
				}
				const apiKey = config.apiKey;
				if (!apiKey) {
					ctx.ui.notify(`pi-jev: no key (${API_KEY_ENV} unset)`, "warning");
					return;
				}
				try {
					const response = await askJev({
						state: text,
						questions: GATE_QUESTIONS,
						apiKey,
						model: config.model,
						endpoint: config.endpoint,
						timeoutMs: config.timeoutMs,
						retries: config.retries,
						signal: ctx.signal,
					});
					const verdict = evaluateGate(response, config);
					last = { tool: "check", verdict, at: Date.now() };
					ctx.ui.notify(
						`pi-jev check: ${summarizeVerdict(verdict)} | ${describeAnswers(response)}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`pi-jev: ${redact(error instanceof Error ? error.message : String(error))}`,
						"error",
					);
				}
				return;
			}

			const key = config.apiKey
				? config.apiKeyFile
					? `apiKeyFile ${config.apiKeyFile}`
					: "apiKey (inline)"
				: `missing (${API_KEY_ENV})`;
			ctx.ui.notify(
				`pi-jev: ${enabled ? "on" : "off"}, mode ${mode}, model ${config.model}, key ${key}, judging ${config.gate.tools.join("/")}, cache ${cache.size}`,
				"info",
			);
		},
	});

	if (config.apiKey) {
		pi.registerTool({
			name: "jev_ask",
			label: "Jev Ask",
			description:
				"Ask TypeSafe Jev typed questions about a piece of text and get calibrated answers (probabilities, a chosen option, a rubric score) instead of prose.",
			promptSnippet:
				"Ask Jev typed questions (yes/no, choice, rubric) about text and get calibrated answers",
			promptGuidelines: [
				"Use jev_ask when a judgement must be typed and calibrated rather than written: classification, relevance, yes/no checks, rubric scores.",
				"Ask one specific question per entry in jev_ask; split multi-factor judgements into separate questions and combine the answers yourself.",
			],
			parameters: AskParams,
			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				const apiKey = config.apiKey;
				if (!apiKey) {
					return {
						content: [
							{ type: "text" as const, text: `jev_ask: no API key (${API_KEY_ENV} unset)` },
						],
						details: { ok: false },
					};
				}
				const questions: Record<string, JevQuestion> = {};
				for (const question of params.questions) {
					const built = toQuestion(question);
					if (typeof built === "string") {
						return {
							content: [
								{ type: "text" as const, text: `jev_ask: ${built}` },
							],
							details: { ok: false },
						};
					}
					questions[question.id] = built;
				}

				try {
					const response = await askJev({
						state: params.state,
						questions,
						apiKey,
						model: config.model,
						endpoint: config.endpoint,
						timeoutMs: config.timeoutMs,
						retries: config.retries,
						signal,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: renderAnswers(response, questions),
							},
						],
						details: {
							ok: true,
							model: response.model,
							usage: response.usage,
							answers: response.answers,
						},
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `jev_ask: ${redact(error instanceof JevError ? error.message : String(error))}`,
							},
						],
						details: { ok: false },
					};
				}
			},
		});
	}
}

interface QuestionParamValue {
	id: string;
	type: "noul" | "choice" | "score";
	instructions: string;
	options?: { name: string; description?: string }[];
	levels?: string[];
}

/** Returns a Jev question, or a message explaining why the shape is invalid. */
function toQuestion(question: QuestionParamValue): JevQuestion | string {
	const { id, instructions } = question;
	if (question.type === "choice") {
		if (!question.options || question.options.length === 0) {
			return `question "${id}": choice needs at least one option`;
		}
		const criteria: Record<string, string | null> = {};
		for (const option of question.options) {
			criteria[option.name] = option.description ?? null;
		}
		return { type: "choice", instructions, criteria };
	}
	if (question.type === "score") {
		if (!question.levels || question.levels.length < 2) {
			return `question "${id}": score needs at least two levels`;
		}
		return { type: "score", instructions, criteria: question.levels };
	}
	return { type: "noul", instructions };
}

function renderAnswers(
	response: JevResponse,
	questions: Record<string, JevQuestion>,
): string {
	const lines = [`model ${response.model}`];
	for (const [id, answer] of Object.entries(response.answers)) {
		const question = questions[id];
		const tail = question ? `  <- ${question.instructions}` : "";
		lines.push(
			`${id}: ${answer.type === "choice" ? formatChoice(answer) : describeAnswer(answer)}${tail}`,
		);
	}
	if (response.usage) {
		lines.push(
			`tokens ${response.usage.input_tokens ?? 0} in / ${response.usage.output_tokens ?? 0} out`,
		);
	}
	return lines.join("\n");
}

function formatChoice(answer: {
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}): string {
	const ranked = Object.entries(answer.probabilities)
		.sort(([, a], [, b]) => b - a)
		.map(([option, probability]) => `${option} ${probability.toFixed(2)}`)
		.join(", ");
	return `${answer.choice} (conf ${answer.confidence.toFixed(2)}) [${ranked}]`;
}

/** Latest user text in the branch, so scope questions can weigh intent. */
function lastUserRequest(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.buildContextEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const text = messageText(message.content);
		if (text) return text;
	}
	return undefined;
}

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const type = Reflect.get(block, "type");
		const text = Reflect.get(block, "text");
		if (type === "text" && typeof text === "string") parts.push(text);
	}
	const joined = parts.join("\n").trim();
	return joined || undefined;
}
