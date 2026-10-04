import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionToolContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ModelRef {
	provider: string;
	id: string;
}

export interface Config {
	model: ModelRef | undefined;
	maxDepth: number;
	maxCalls: number;
	trace: boolean;
}

export const NAMESPACE = {
	name: "rlm",
	description:
		"Recursive sub-calls: ask a model one question, or start child agents that run scripts of their own, then message, collect or cancel them.",
};

export const MODEL_REF = Type.Object(
	{ provider: Type.String(), id: Type.String() },
	{
		description:
			"Default: model from ~/.pi/agent/pi-rlm.json, else the session model. A ModelInfo from models.getModelOfType() works.",
	},
);

function count(path: string, key: string, value: unknown, min: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new Error(`${path}: ${key} must be an integer of at least ${min}`);
	}
	return value;
}

export function readConfig(): Config {
	const path = join(getAgentDir(), "pi-rlm.json");
	const config: Config = { model: undefined, maxDepth: 2, maxCalls: 8, trace: false };
	if (!existsSync(path)) return config;
	const data: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof data !== "object" || data === null || Array.isArray(data))
		throw new Error(`${path}: expected a JSON object`);
	for (const [key, value] of Object.entries(data)) {
		if (key === "model") {
			const match = typeof value === "string" ? /^([^/]+)\/(.+)$/.exec(value) : null;
			if (!match) throw new Error(`${path}: model must be "provider/id"`);
			config.model = { provider: match[1], id: match[2] };
		} else if (key === "maxDepth") {
			config.maxDepth = count(path, key, value, 0);
		} else if (key === "maxCalls") {
			config.maxCalls = count(path, key, value, 1);
		} else if (key === "trace") {
			if (typeof value !== "boolean") throw new Error(`${path}: trace must be true or false`);
			config.trace = value;
		} else {
			throw new Error(`${path}: unknown key "${key}"`);
		}
	}
	return config;
}

export function resolveModel(ctx: ExtensionToolContext, ref: ModelRef | undefined) {
	if (!ref) {
		if (!ctx.model) throw new Error("rlm: no model given and the session has none");
		return ctx.model;
	}
	const model = ctx.modelRegistry.getModelOfType("chat", ref.provider, ref.id);
	if (!model) throw new Error(`rlm: unknown chat model "${ref.provider}/${ref.id}"`);
	return model;
}

export function replyText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
