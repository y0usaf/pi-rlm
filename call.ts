import { appendFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Config, errorText, MODEL_REF, NAMESPACE, replyText, resolveModel } from "./config.ts";

const NOT_STARTED = "rlm: aborted before the call started";

let running = 0;
const queue: (() => void)[] = [];
const failedTraces = new Set<string>();

async function acquire(limit: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error(NOT_STARTED);
	if (running < limit) {
		running++;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const grant = () => {
			signal?.removeEventListener("abort", cancel);
			resolve();
		};
		const cancel = () => {
			queue.splice(queue.indexOf(grant), 1);
			reject(new Error(NOT_STARTED));
		};
		queue.push(grant);
		signal?.addEventListener("abort", cancel, { once: true });
	});
}

function release(): void {
	const next = queue.shift();
	if (next) next();
	else running--;
}

export function registerCall(pi: ExtensionAPI, config: Config, warn: (message: string) => void): void {
	pi.registerTool({
		name: "rlm",
		label: "RLM",
		namespace: NAMESPACE,
		description:
			"Send one prompt to a model and get its text reply. The prompt is the whole context: no tools, no history. " +
			"Each call has overhead, so put many items in one prompt and aim for tens of calls, not thousands. " +
			`At most ${config.maxCalls} calls run at once; the rest queue. ` +
			"Rejects if the call fails, is aborted or hits the output limit. For a sub-task that needs tools or several steps, use rlm_spawn.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Everything the model sees besides the system prompt." }),
			system: Type.Optional(Type.String({ description: "System prompt." })),
			model: Type.Optional(MODEL_REF),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		exposure: "codemode",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const model = resolveModel(ctx, params.model ?? config.model);
			await acquire(config.maxCalls, signal);
			if (signal?.aborted) {
				release();
				throw new Error(NOT_STARTED);
			}
			const startedAt = Date.now();
			let message: AssistantMessage;
			try {
				message = await ctx.modelRegistry
					.streamSimple(
						model,
						{
							systemPrompt: params.system,
							messages: [{ role: "user", content: params.prompt, timestamp: startedAt }],
						},
						{ signal },
					)
					.result();
			} finally {
				release();
			}
			const text = replyText(message);
			const { stopReason, usage, errorMessage } = message;
			const sessionFile = ctx.sessionManager.getSessionFile();
			const tracePath = sessionFile?.replace(/\.jsonl$/, ".rlm.ndjson");
			if (config.trace && tracePath && !failedTraces.has(tracePath)) {
				const record = {
					id: toolCallId,
					ts: new Date(startedAt).toISOString(),
					ms: Date.now() - startedAt,
					provider: model.provider,
					model: model.id,
					system: params.system ?? null,
					prompt: params.prompt,
					text,
					usage,
					stopReason,
					error: errorMessage ?? null,
				};
				try {
					appendFileSync(tracePath, `${JSON.stringify(record)}\n`);
				} catch (error) {
					failedTraces.add(tracePath);
					warn(`rlm: tracing stopped for ${tracePath}: ${errorText(error)}`);
				}
			}
			const failed = stopReason !== "stop";
			return {
				content: [
					{ type: "text", text: failed ? `rlm ${stopReason}${errorMessage ? `: ${errorMessage}` : ""}` : text },
				],
				details: undefined,
				usage,
				isError: failed,
			};
		},
	});
}
