/**
 * The output judge: what to ask Jev about a tool result that already ran, and
 * how to turn the answers into something the model and the user act on.
 *
 * The tool_call gate sees intent. It cannot see what a command actually
 * printed, so it cannot catch a credential echoed into the transcript or tell
 * a transient failure from a permanent one. Both are judgements about text
 * that exists only after the call.
 *
 * Question phrasing and thresholds come from the probe in README.md: the leak
 * question separated 0.92-0.99 from 0.01-0.02 with no overlap, and the failure
 * class answered at confidence 0.88-1.00 when it was right and 0.42 when it was
 * unsure, which is why a confidence floor silences the advice.
 */

import {
	answerFor,
	confidenceFor,
	type JevQuestion,
	type JevResponse,
	type JevState,
} from "./client";
import type { JevConfig } from "./config";

export interface OutputInput {
	cwd: string;
	toolName: string;
	input: unknown;
	/** Text of the tool result, already rendered by the tool. */
	output: string;
	isError: boolean;
	outputChars: number;
}

export interface OutputVerdict {
	/** Probability that the output carries a secret. */
	leaksSecret: number;
	/** Option name, or undefined when the answer was unusable. */
	failureClass: string | undefined;
	classConfidence: number | undefined;
	/** Leak reason when the leak threshold was crossed, else the advice line. */
	notice: string | undefined;
	kind: "leak" | "advice" | "none";
	answers: Record<string, unknown>;
	model: string;
}

/**
 * Two questions, one request. The class question is asked even on success
 * because a request costs the same either way and the answer is ignored.
 */
export const OUTPUT_QUESTIONS: Record<string, JevQuestion> = {
	leaks_secret: {
		type: "noul",
		instructions:
			"Does `output` contain a secret or credential that must not be written to a session transcript?",
		criteria: {
			true: "A key, token, password, or private key appears in the text",
			false: "Only ordinary program output",
		},
	},
	failure_class: {
		type: "choice",
		instructions: "What kind of failure is `output` reporting?",
		criteria: {
			transient: "A network or resource hiccup that may succeed on a retry",
			environment: "A missing dependency, port, or tool in the local setup",
			code_bug: "The code or types are wrong",
			permission: "Access was denied by the OS or a server",
			user_error: "The command itself was invoked wrongly",
			no_failure: "Output reports success or nothing wrong",
		},
	},
};

/**
 * What to tell the model per class. A table, not a branch: the class names are
 * Jev's, and adding one is a row rather than a code path.
 */
export const CLASS_ADVICE: Record<string, string> = {
	transient: "retrying the same command unchanged is reasonable",
	environment: "fix the environment (missing tool, port, or service) before retrying",
	code_bug: "fix the code or types; retrying unchanged will not help",
	permission: "access was denied; change what is being accessed or ask the user",
	user_error: "the invocation itself was wrong; fix the command",
};

/** Keyed by tool and output hash: identical output must cost one judgement. */
export function outputKey(toolName: string, output: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < output.length; index += 1) {
		hash ^= output.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${toolName}:${output.length}:${hash.toString(16)}`;
}

export function buildOutputState(input: OutputInput): JevState {
	return {
		cwd: input.cwd,
		tool: input.toolName,
		is_error: input.isError,
		arguments: summarize(input.input, 400),
		output: truncate(input.output, input.outputChars),
	};
}

export function evaluateOutput(
	response: JevResponse,
	config: JevConfig,
): OutputVerdict {
	const leak = answerFor(response, "leaks_secret");
	const leaksSecret = leak?.type === "noul" ? leak.noul : 0;
	const classAnswer = answerFor(response, "failure_class");
	const failureClass =
		classAnswer?.type === "choice" ? classAnswer.choice : undefined;
	const classConfidence = confidenceFor(response, "failure_class");

	let notice: string | undefined;
	let kind: OutputVerdict["kind"] = "none";
	if (leaksSecret >= config.output.leakThreshold) {
		kind = "leak";
		notice = `Jev flagged this output as containing a secret (${leaksSecret.toFixed(2)}). Do not repeat the value in a reply, a file, or a command; refer to it by name instead.`;
	} else if (
		failureClass &&
		CLASS_ADVICE[failureClass] &&
		(classConfidence === undefined ||
			classConfidence >= config.output.minConfidence)
	) {
		kind = "advice";
		notice = `Jev read this as a ${failureClass} failure (confidence ${classConfidence?.toFixed(2) ?? "n/a"}): ${CLASS_ADVICE[failureClass]}.`;
	}

	return {
		leaksSecret,
		failureClass,
		classConfidence,
		notice,
		kind,
		answers: response.answers,
		model: response.model,
	};
}

/** Same elision rule as the gate: long strings leave as a prefix plus a count. */
function summarize(value: unknown, maxChars: number, depth = 0): unknown {
	if (typeof value === "string") return truncate(value, maxChars);
	if (depth > 3 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((item) => summarize(item, maxChars, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = summarize(item, maxChars, depth + 1);
	}
	return out;
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars
		? `${text.slice(0, maxChars)}\u2026[${text.length - maxChars} chars elided]`
		: text;
}
