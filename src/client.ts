/**
 * TypeSafe Jev client - the whole wire protocol.
 *
 * Jev evaluates typed questions against a state and returns typed answers
 * (probabilities, a chosen option, a rubric value). It does not generate text,
 * so nothing here produces prose: callers branch, sort, or route on the
 * numbers. See https://docs.typesafe.ai.
 *
 * This module intentionally imports nothing from Pi. It is fetch + types, so it
 * can be exercised on its own with `node --input-type=module`.
 */

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIES = 2;

/** Text, or structured data (chat logs, records, current application state). */
export type JevState = string | Record<string, unknown> | unknown[];

/** Yes/no question. Returns the probability that the answer is yes. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: {
		true?: string;
		false?: string;
	};
}

/** Pick one option. Option key -> rubric description; null means no detail. */
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string | null>;
}

/** Ordered rubric. At least two levels. Returns a probability-weighted value. */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
	type: "noul";
	noul: number;
}

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
	input_tokens?: number;
	output_tokens?: number;
}

export interface JevResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: JevUsage;
}

export interface JevCall {
	state: JevState;
	questions: Record<string, JevQuestion>;
	apiKey: string;
	model?: string;
	endpoint?: string;
	timeoutMs?: number;
	retries?: number;
	/** Nested work should pass the extension context signal so Esc cancels it. */
	signal?: AbortSignal;
}

export class JevError extends Error {
	readonly status: number | undefined;
	readonly retryable: boolean;

	constructor(message: string, status?: number, retryable = false) {
		super(message);
		this.name = "JevError";
		this.status = status;
		this.retryable = retryable;
	}
}

const RETRYABLE_STATUS = new Set([429, 529]);

/**
 * Evaluate every question against the state in one request. Questions run in
 * parallel and in isolation, so adding questions barely changes latency.
 */
export async function askJev(call: JevCall): Promise<JevResponse> {
	validateQuestions(call.questions);
	const endpoint = call.endpoint ?? DEFAULT_ENDPOINT;
	const body = JSON.stringify({
		state: call.state,
		model: call.model ?? DEFAULT_MODEL,
		questions: call.questions,
	});
	const retries = call.retries ?? DEFAULT_RETRIES;
	let lastError: JevError | undefined;

	for (let attempt = 0; attempt <= retries; attempt += 1) {
		if (call.signal?.aborted) break;
		if (attempt > 0) await delay(backoffMs(attempt), call.signal);
		try {
			return await postOnce(endpoint, body, call);
		} catch (error) {
			const failure = asJevError(error);
			lastError = failure;
			if (!failure.retryable) throw failure;
		}
	}

	throw lastError ?? new JevError("request aborted", undefined, false);
}

async function postOnce(
	endpoint: string,
	body: string,
	call: JevCall,
): Promise<JevResponse> {
	const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeout = new AbortController();
	const timer = setTimeout(
		() =>
			timeout.abort(
				new JevError(`request timed out after ${timeoutMs}ms`, undefined, true),
			),
		timeoutMs,
	);

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${call.apiKey}`,
				"Content-Type": "application/json",
			},
			body,
			signal: combineSignals([timeout.signal, ...(call.signal ? [call.signal] : [])]),
		});
		const text = await response.text();

		if (!response.ok) {
			const retryable =
				RETRYABLE_STATUS.has(response.status) || response.status >= 500;
			throw new JevError(
				`HTTP ${response.status}${statusHint(response.status)}: ${truncate(text, 400)}`,
				response.status,
				retryable,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new JevError(
				`response was not JSON: ${truncate(text, 200)}`,
				response.status,
				false,
			);
		}
		return normalizeResponse(parsed);
	} finally {
		clearTimeout(timer);
	}
}

function statusHint(status: number): string {
	switch (status) {
		case 401:
			return " (missing or invalid API key)";
		case 422:
			return " (request body failed validation - check the question shape)";
		case 429:
			return " (rate limited)";
		case 529:
			return " (overloaded)";
		default:
			return "";
	}
}

/** Fail early with a useful message instead of paying for a 422. */
function validateQuestions(questions: Record<string, JevQuestion>): void {
	const entries = Object.entries(questions);
	if (entries.length === 0) {
		throw new JevError("no questions provided");
	}
	for (const [id, question] of entries) {
		if (typeof question?.instructions !== "string" || !question.instructions.trim()) {
			throw new JevError(`question "${id}": instructions are required`);
		}
		if (question.type === "score" && question.criteria.length < 2) {
			throw new JevError(`question "${id}": score needs at least two levels`);
		}
		if (
			question.type === "choice" &&
			Object.keys(question.criteria ?? {}).length === 0
		) {
			throw new JevError(`question "${id}": choice needs at least one option`);
		}
	}
}

function normalizeResponse(value: unknown): JevResponse {
	if (typeof value !== "object" || value === null) {
		throw new JevError("response was not an object");
	}
	const answers = Reflect.get(value, "answers");
	if (typeof answers !== "object" || answers === null) {
		throw new JevError("response is missing the answers map");
	}
	for (const [id, answer] of Object.entries(answers)) {
		if (!isJevAnswer(answer)) {
			throw new JevError(`answer "${id}" has an unknown shape`);
		}
	}
	const model = Reflect.get(value, "model");
	const usage = Reflect.get(value, "usage");
	// Invariant: every entry above passed isJevAnswer, so the map is typed.
	return {
		model: typeof model === "string" ? model : DEFAULT_MODEL,
		answers: answers as Record<string, JevAnswer>,
		usage: isUsage(usage) ? usage : undefined,
	};
}

function isUsage(value: unknown): value is JevUsage {
	if (typeof value !== "object" || value === null) return false;
	const input = Reflect.get(value, "input_tokens");
	const output = Reflect.get(value, "output_tokens");
	return (
		(input === undefined || typeof input === "number") &&
		(output === undefined || typeof output === "number")
	);
}

function isJevAnswer(value: unknown): value is JevAnswer {
	if (typeof value !== "object" || value === null) return false;
	const type: unknown = Reflect.get(value, "type");
	if (type === "noul") return typeof Reflect.get(value, "noul") === "number";
	if (type === "choice") return typeof Reflect.get(value, "choice") === "string";
	if (type === "score") return typeof Reflect.get(value, "score") === "number";
	return false;
}

/** Abort when any source aborts. Local helper: no dependency on AbortSignal.any. */
function combineSignals(sources: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const source of sources) {
		if (source.aborted) {
			controller.abort(source.reason);
			break;
		}
		source.addEventListener(
			"abort",
			() => {
				if (!controller.signal.aborted) controller.abort(source.reason);
			},
			{ once: true },
		);
	}
	return controller.signal;
}

function asJevError(error: unknown): JevError {
	if (error instanceof JevError) return error;
	/** fetch() surfaces a caller or deadline abort as the abort reason. */
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		const reason = Reflect.get(error, "cause");
		return reason instanceof JevError
			? reason
			: new JevError("request aborted", undefined, false);
	}
	return new JevError(
		error instanceof Error ? error.message : String(error),
		undefined,
		true,
	);
}

function backoffMs(attempt: number): number {
	const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
	return base + Math.floor(Math.random() * 250);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}\u2026` : collapsed;
}

export function answerFor(
	response: JevResponse,
	id: string,
): JevAnswer | undefined {
	return response.answers[id];
}

/**
 * Secrets observed this process, so no notification or state string can leak an
 * API key back into the session transcript. Registration happens once at load.
 */
const secrets = new Set<string>();

export function rememberSecret(secret: string | undefined): void {
	if (secret && secret.trim().length >= 8) secrets.add(secret.trim());
}

export function redact(text: string): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("[redacted]");
	return out;
}

/** Probability that a noul answered yes, or undefined if the id is not a noul. */
export function noulValue(
	response: JevResponse,
	id: string,
): number | undefined {
	const answer = response.answers[id];
	return answer?.type === "noul" ? answer.noul : undefined;
}

/** Noul answers carry no confidence; only choice and score do. */
export function confidenceFor(
	response: JevResponse,
	id: string,
): number | undefined {
	const answer = response.answers[id];
	return answer && answer.type !== "noul" ? answer.confidence : undefined;
}

/** Compact single-line rendering for notify()/status text. */
export function describeAnswer(answer: JevAnswer | undefined): string {
	if (!answer) return "no answer";
	if (answer.type === "noul") return `yes ${answer.noul.toFixed(2)}`;
	if (answer.type === "choice") {
		return `${answer.choice} (conf ${answer.confidence.toFixed(2)})`;
	}
	const levels = Object.keys(answer.legend ?? {}).length - 1;
	return `${answer.score.toFixed(2)}${levels > 0 ? `/${levels}` : ""} (conf ${answer.confidence.toFixed(2)})`;
}
