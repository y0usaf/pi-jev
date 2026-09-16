/**
 * Config for the Jev extensions.
 *
 * Transport settings (endpoint, model, key, timeout) live here because this is
 * the only place that talks to the API, and the key should be resolved in
 * exactly one place.
 *
 * Layering: built-in defaults <- ~/.pi/agent/pi-jev.json <- <cwd>/.pi/pi-jev.json.
 * Project settings win. Only keys actually present in a file override, so a
 * project file can set one field without restating the rest.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_ENDPOINT,
	DEFAULT_MODEL,
	DEFAULT_RETRIES,
	DEFAULT_TIMEOUT_MS,
} from "./client";

export const CONFIG_FILE = "pi-jev.json";
export const API_KEY_ENV = "TYPESAFE_API_KEY";

/** shadow reports but never blocks; enforce can block a tool call. */
export type GateMode = "shadow" | "enforce";

export interface GateThresholds {
	/** Noul probability at or above which the dimension counts as triggered. */
	destructive: number;
	exfiltration: number;
	beyondScope: number;
	/** Score on the 4-level damage rubric. */
	impact: number;
}

export interface GateConfig {
	enabled: boolean;
	mode: GateMode;
	/** Tool names to judge. Everything else runs unjudged. */
	tools: string[];
	/** Elide string fields longer than this from the state sent to Jev. */
	argumentChars: number;
	/** Reuse a verdict for identical tool input within this window. */
	cacheSeconds: number;
	blockOn: GateThresholds;
	/** Minimum confidence on the impact answer before a block is allowed. */
	minConfidence: number;
	/**
	 * Block in non-interactive runs. Off by default: with no UI there is no way
	 * to approve a flagged call, so enforcement would deadlock automation on a
	 * classifier's opinion.
	 */
	blockWithoutUI: boolean;
}

export interface JevConfig {
	endpoint: string;
	model: string;
	apiKey: string | undefined;
	apiKeyFile: string | undefined;
	timeoutMs: number;
	retries: number;
	/** Cap on the serialized state handed to Jev. */
	maxStateChars: number;
	gate: GateConfig;
}

export interface LoadedJevConfig {
	config: JevConfig;
	warnings: string[];
}

/** A config file with only the keys it actually declared. */
interface ParsedGate extends Partial<Omit<GateConfig, "blockOn">> {
	blockOn?: Partial<GateThresholds>;
}

interface ParsedConfigFile extends Partial<Omit<JevConfig, "gate">> {
	gate?: ParsedGate;
}

export function defaultJevConfig(): JevConfig {
	return {
		endpoint: DEFAULT_ENDPOINT,
		model: DEFAULT_MODEL,
		apiKey: undefined,
		apiKeyFile: undefined,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		retries: DEFAULT_RETRIES,
		maxStateChars: 8000,
		gate: {
			enabled: true,
			mode: "shadow",
			tools: ["bash", "write", "edit"],
			argumentChars: 400,
			cacheSeconds: 120,
			blockOn: { destructive: 0.9, exfiltration: 0.7, beyondScope: 0.85, impact: 2.5 },
			minConfidence: 0.5,
			blockWithoutUI: false,
		},
	};
}

export function loadJevConfig(cwd: string): LoadedJevConfig {
	const defaults = defaultJevConfig();
	const warnings: string[] = [];
	const global = readConfigFile(join(getAgentDir(), CONFIG_FILE), warnings);
	const project = readConfigFile(
		join(cwd, CONFIG_DIR_NAME, CONFIG_FILE),
		warnings,
	);

	const config: JevConfig = {
		...defaults,
		...global,
		...project,
		gate: {
			...defaults.gate,
			...global.gate,
			...project.gate,
			blockOn: {
				...defaults.gate.blockOn,
				...global.gate?.blockOn,
				...project.gate?.blockOn,
			},
			tools: project.gate?.tools ?? global.gate?.tools ?? defaults.gate.tools,
		},
	};

	const key = resolveApiKey(config, warnings);
	return { config: { ...config, apiKey: key }, warnings };
}

/**
 * Env wins over config, so a host can inject the key without touching files.
 * apiKeyFile supports "~/" because keys usually live outside the repo.
 */
export function resolveApiKey(
	config: Pick<JevConfig, "apiKey" | "apiKeyFile">,
	warnings: string[] = [],
): string | undefined {
	const fromEnv = process.env[API_KEY_ENV]?.trim();
	if (fromEnv) return fromEnv;
	if (config.apiKey?.trim()) return config.apiKey.trim();
	if (!config.apiKeyFile) return undefined;

	const path = expandHome(config.apiKeyFile);
	try {
		const contents = readFileSync(path, "utf8").trim();
		return contents.length > 0 ? contents : undefined;
	} catch (error) {
		warnings.push(
			`${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function readConfigFile(path: string, warnings: string[]): ParsedConfigFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		// Missing file is the normal case; anything else is worth reporting.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			warnings.push(
				`${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		warnings.push(
			`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) {
		warnings.push(`${path}: expected a JSON object`);
		return {};
	}

	const out: ParsedConfigFile = {};

	const endpoint = asString(Reflect.get(parsed, "endpoint"));
	if (endpoint) out.endpoint = endpoint;
	const model = asString(Reflect.get(parsed, "model"));
	if (model) out.model = model;
	const apiKey = asString(Reflect.get(parsed, "apiKey"));
	if (apiKey) out.apiKey = apiKey;
	const apiKeyFile = asString(Reflect.get(parsed, "apiKeyFile"));
	if (apiKeyFile) out.apiKeyFile = apiKeyFile;
	const timeoutMs = asPositiveInt(Reflect.get(parsed, "timeoutMs"));
	if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
	const retries = asNonNegativeInt(Reflect.get(parsed, "retries"));
	if (retries !== undefined) out.retries = retries;
	const maxStateChars = asPositiveInt(Reflect.get(parsed, "maxStateChars"));
	if (maxStateChars !== undefined) out.maxStateChars = maxStateChars;

	const gate = Reflect.get(parsed, "gate");
	if (typeof gate === "object" && gate !== null) {
		const parsedGate: ParsedGate = {};
		const enabled = Reflect.get(gate, "enabled");
		if (typeof enabled === "boolean") parsedGate.enabled = enabled;
		const mode = Reflect.get(gate, "mode");
		if (mode === "shadow" || mode === "enforce") parsedGate.mode = mode;
		const tools = Reflect.get(gate, "tools");
		if (Array.isArray(tools)) {
			const names = tools.filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			);
			if (names.length > 0) parsedGate.tools = names;
		}
		const cacheSeconds = asNonNegativeInt(Reflect.get(gate, "cacheSeconds"));
		if (cacheSeconds !== undefined) parsedGate.cacheSeconds = cacheSeconds;
		const argumentChars = asPositiveInt(Reflect.get(gate, "argumentChars"));
		if (argumentChars !== undefined) parsedGate.argumentChars = argumentChars;
		const blockWithoutUI = Reflect.get(gate, "blockWithoutUI");
		if (typeof blockWithoutUI === "boolean") {
			parsedGate.blockWithoutUI = blockWithoutUI;
		}
		const minConfidence = asRatio(Reflect.get(gate, "minConfidence"));
		if (minConfidence !== undefined) parsedGate.minConfidence = minConfidence;

		const blockOn = Reflect.get(gate, "blockOn");
		if (typeof blockOn === "object" && blockOn !== null) {
			const thresholds: Partial<GateThresholds> = {};
			const destructive = asRatio(Reflect.get(blockOn, "destructive"));
			if (destructive !== undefined) thresholds.destructive = destructive;
			const exfiltration = asRatio(Reflect.get(blockOn, "exfiltration"));
			if (exfiltration !== undefined) thresholds.exfiltration = exfiltration;
			const beyondScope = asRatio(Reflect.get(blockOn, "beyondScope"));
			if (beyondScope !== undefined) thresholds.beyondScope = beyondScope;
			const impact = Reflect.get(blockOn, "impact");
			if (typeof impact === "number" && Number.isFinite(impact) && impact >= 0) {
				thresholds.impact = impact;
			}
			parsedGate.blockOn = thresholds;
		}
		out.gate = parsedGate;
	}

	return out;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

function asRatio(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: undefined;
}
