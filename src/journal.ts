/**
 * Verdict journal: what the extension already decided, kept in the session so
 * `/jev last`, `/jev output`, and `/jev log` survive a reload, a resume, or a
 * fork - which is exactly when a record of what fired is worth having.
 *
 * A record is written with `pi.appendEntry("jev", ...)`: a pi custom entry that
 * never enters the LLM context and costs no Jev request, because it renders a
 * verdict that was already computed.
 *
 * Sessions are files on disk and users edit them, so every read here is
 * defensive: a record that does not parse is dropped, not thrown. Writes fail
 * open too - a journal error must never escape a tool_call/tool_result handler.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GateVerdict } from "./gate";
import { describeAnswers, summarizeVerdict } from "./gate";
import type { OutputVerdict } from "./output";

/** Exactly this customType identifies our entries; anything else is not ours. */
export const JOURNAL_TYPE = "jev";

/**
 * Records kept in memory and rehydrated. The session file itself is append-only
 * (pi forbids editing entries), so this caps what the extension holds and what
 * `/jev log` prints, not what has been written.
 */
export const JOURNAL_CAP = 100;

/** How many records `/jev log` prints. */
export const JOURNAL_TAIL = 10;

/** A flagged gate verdict, as `/jev last` shows it. */
export interface GateRecord {
	kind: "gate";
	at: number;
	tool: string;
	/** summarizeVerdict() output: the crossed dimensions and their values. */
	summary: string;
	/** describeAnswers() output: every answer, so the record explains itself. */
	answers: string;
}

/** A leak/advice output verdict, as `/jev output` shows it. */
export interface OutputRecord {
	kind: "output";
	at: number;
	tool: string;
	notice: "leak" | "advice";
	leaksSecret: number;
	failureClass: string | undefined;
	classConfidence: number | undefined;
}

export type JournalRecord = GateRecord | OutputRecord;

export function gateRecord(
	tool: string,
	verdict: GateVerdict,
	at: number,
): GateRecord {
	return {
		kind: "gate",
		at,
		tool,
		summary: summarizeVerdict(verdict),
		answers: describeAnswers({ answers: verdict.answers }),
	};
}

/** Only called for a verdict that carries a notice, so the kind is leak/advice. */
export function outputRecord(
	tool: string,
	verdict: OutputVerdict,
	at: number,
): OutputRecord {
	return {
		kind: "output",
		at,
		tool,
		notice: verdict.kind === "leak" ? "leak" : "advice",
		leaksSecret: verdict.leaksSecret,
		failureClass: verdict.failureClass,
		classConfidence: verdict.classConfidence,
	};
}

/** The display line for a record, prefixed by the caller. */
export function describeRecord(record: JournalRecord): string {
	if (record.kind === "gate") {
		return `${record.tool} - ${record.summary} | ${record.answers}`;
	}
	return `${record.tool} - ${record.notice} | leak ${record.leaksSecret.toFixed(2)} | class ${record.failureClass ?? "none"} at ${record.classConfidence?.toFixed(2) ?? "n/a"}`;
}

/** Local clock time, no locale data needed. */
export function recordClock(record: JournalRecord): string {
	return new Date(record.at).toTimeString().slice(0, 8);
}

/** Append to the in-memory list, dropping the oldest past the cap. */
export function capped(records: JournalRecord[]): JournalRecord[] {
	return records.length > JOURNAL_CAP ? records.slice(-JOURNAL_CAP) : records;
}

/** The newest record of a kind, so `/jev last` reads the same live and reloaded. */
export function newest(
	records: JournalRecord[],
	kind: JournalRecord["kind"],
): JournalRecord | undefined {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (record?.kind === kind) return record;
	}
	return undefined;
}

/**
 * Persist one record. Fail open: a session that cannot be written to must not
 * turn a reported flag into a failed tool call.
 */
export function writeRecord(pi: ExtensionAPI, record: JournalRecord): void {
	try {
		pi.appendEntry(JOURNAL_TYPE, record);
	} catch {
		// Nothing to do: the journal is an audit trail, not a gate.
	}
}

/** Rebuild the journal from a session's entries, oldest first. */
export function recordsFromEntries(entries: readonly unknown[]): JournalRecord[] {
	const records: JournalRecord[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		if (Reflect.get(entry, "type") !== "custom") continue;
		if (Reflect.get(entry, "customType") !== JOURNAL_TYPE) continue;
		const record = parseRecord(Reflect.get(entry, "data"));
		if (record) records.push(record);
	}
	return capped(records);
}

/** A record from a hand-editable file, or undefined when it cannot be trusted. */
export function parseRecord(value: unknown): JournalRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const at = Reflect.get(value, "at");
	const tool = Reflect.get(value, "tool");
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
	if (typeof tool !== "string" || !tool) return undefined;

	const kind = Reflect.get(value, "kind");
	if (kind === "gate") {
		const summary = Reflect.get(value, "summary");
		if (typeof summary !== "string") return undefined;
		const answers = Reflect.get(value, "answers");
		return {
			kind: "gate",
			at,
			tool,
			summary,
			answers: typeof answers === "string" ? answers : "",
		};
	}
	if (kind === "output") {
		const notice = Reflect.get(value, "notice");
		const leaksSecret = Reflect.get(value, "leaksSecret");
		if (notice !== "leak" && notice !== "advice") return undefined;
		if (typeof leaksSecret !== "number" || !Number.isFinite(leaksSecret)) {
			return undefined;
		}
		const failureClass = Reflect.get(value, "failureClass");
		const classConfidence = Reflect.get(value, "classConfidence");
		return {
			kind: "output",
			at,
			tool,
			notice,
			leaksSecret,
			failureClass: typeof failureClass === "string" ? failureClass : undefined,
			classConfidence:
				typeof classConfidence === "number" && Number.isFinite(classConfidence)
					? classConfidence
					: undefined,
		};
	}
	return undefined;
}
