import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	getAgentDir,
	rawKeyHint,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openView, type RlmDetails, renderRlmMessage, statusWidget } from "./ui.ts";

const MAX_CONCURRENT_CALLS = 8;
const MAX_RUNNING_CHILDREN = 8;
const DEFAULT_MAX_DEPTH = 2;
const STOP_BUDGET_MS = 5000;
const VIEW_KEY = "alt+r";
const ANSWER_DETAIL_CHARS = 20000;
const PREVIEW_CHARS = 300;
const TRACE_SUFFIX = ".rlm.ndjson";
const DEPTH_ENTRY = "rlm-depth";
const ID_ENTRY = "rlm-next-id";
const ID_PATTERN = /^c\d+$/;
const NOT_STARTED = "rlm: aborted before the call started";
const RLM_TOOLS = ["rlm", "rlm_spawn", "rlm_collect", "rlm_send", "rlm_cancel"];
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type ModelRef = { provider: string; id: string };
type Status = "running" | "done" | "failed" | "cancelled";
type UI = ExtensionContext["ui"];

export interface Scope {
	depth: number;
	toParent?: (text: string) => void;
	children: Map<string, Child>;
	closed: boolean;
	carry: Usage;
	notify: (message: string) => void;
	changed: () => void;
	send?: (child: Child, message: string) => Promise<"steered" | "restarted">;
	cancel?: (child: Child) => Promise<unknown>;
}

export interface Child {
	id: string;
	name: string;
	session: AgentSession;
	sessionManager: SessionManager;
	scope: Scope;
	owner: Scope;
	activity?: string;
	tracePath: string | undefined;
	status: Status;
	counted: boolean;
	startedAt: number;
	endedAt?: number;
	error?: string;
	run: Promise<void>;
	endRun: () => void;
	pending: boolean;
	waiters: number;
	billed: Usage;
}

const MODEL_REF = Type.Object(
	{ provider: Type.String(), id: Type.String() },
	{ description: "Default: model from ~/.pi/agent/pi-rlm.json, else the session model. A ModelInfo from models.getModelOfType() works." },
);
const THINKING = Type.Union(
	[
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	],
	{ description: "Default: this session's thinking level." },
);
const SNAPSHOT = Type.Object({
	id: Type.String(),
	name: Type.String(),
	status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]),
	answer: Type.String({ description: "The child's latest reply; final once status is not running." }),
	error: Type.Union([Type.String(), Type.Null()]),
	ms: Type.Number(),
	cost: Type.Number(),
	session: Type.Union([Type.String(), Type.Null()]),
});

function readConfig(): { maxDepth: number; model?: ModelRef } {
	const path = join(getAgentDir(), "pi-rlm.json");
	if (!existsSync(path)) return { maxDepth: DEFAULT_MAX_DEPTH };
	const data: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof data !== "object" || data === null) throw new Error(`${path}: expected a JSON object`);
	const maxDepth = "maxDepth" in data ? data.maxDepth : DEFAULT_MAX_DEPTH;
	if (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 0) {
		throw new Error(`${path}: maxDepth must be a non-negative integer`);
	}
	if (!("model" in data)) return { maxDepth };
	const match = typeof data.model === "string" ? /^([^/]+)\/(.+)$/.exec(data.model) : null;
	if (!match) throw new Error(`${path}: model must be "provider/id"`);
	return { maxDepth, model: { provider: match[1], id: match[2] } };
}

const config = readConfig();

let activeCalls = 0;
const waitingCalls: (() => void)[] = [];

async function acquireSlot(signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error(NOT_STARTED);
	if (activeCalls < MAX_CONCURRENT_CALLS) {
		activeCalls++;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const grant = () => {
			signal?.removeEventListener("abort", cancel);
			resolve();
		};
		const cancel = () => {
			waitingCalls.splice(waitingCalls.indexOf(grant), 1);
			reject(new Error(NOT_STARTED));
		};
		waitingCalls.push(grant);
		signal?.addEventListener("abort", cancel, { once: true });
	});
}

function releaseSlot(): void {
	const next = waitingCalls.shift();
	if (next) next();
	else activeCalls--;
}

let runningChildren = 0;

function reserveChild(): void {
	if (runningChildren >= MAX_RUNNING_CHILDREN) {
		throw new Error(`rlm: ${MAX_RUNNING_CHILDREN} children are already running; collect or cancel some first`);
	}
	runningChildren++;
}

const failedTraces = new Set<string>();
const checkedTraces = new Set<string>();

function tracePathOf(ctx: ExtensionToolContext): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	return sessionFile ? sessionFile.replace(/\.jsonl$/, "") + TRACE_SUFFIX : undefined;
}

function endsMidLine(path: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return false;
	}
	try {
		const { size } = fstatSync(fd);
		if (size === 0) return false;
		const last = new Uint8Array(1);
		readSync(fd, last, 0, 1, size - 1);
		return last[0] !== 0x0a;
	} finally {
		closeSync(fd);
	}
}

function appendTrace(notify: (message: string) => void, path: string | undefined, record: object): void {
	if (!path || failedTraces.has(path)) return;
	try {
		if (!checkedTraces.has(path)) {
			if (endsMidLine(path)) appendFileSync(path, "\n");
			checkedTraces.add(path);
		}
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch (error) {
		failedTraces.add(path);
		notify(`rlm: tracing stopped for ${path}: ${errorText(error)}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveModel(ctx: ExtensionToolContext, ref: ModelRef | undefined): Model<any> {
	if (!ref) {
		if (!ctx.model) throw new Error("rlm: no model given and the session has none");
		return ctx.model;
	}
	const model = ctx.modelRegistry.getModelOfType("chat", ref.provider, ref.id);
	if (!model) throw new Error(`rlm: unknown chat model "${ref.provider}/${ref.id}"`);
	return model;
}

function replyText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function addUsage(a: Usage, b: Usage, sign: 1 | -1 = 1): Usage {
	return {
		input: a.input + sign * b.input,
		output: a.output + sign * b.output,
		cacheRead: a.cacheRead + sign * b.cacheRead,
		cacheWrite: a.cacheWrite + sign * b.cacheWrite,
		totalTokens: a.totalTokens + sign * b.totalTokens,
		cost: {
			input: a.cost.input + sign * b.cost.input,
			output: a.cost.output + sign * b.cost.output,
			cacheRead: a.cost.cacheRead + sign * b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + sign * b.cost.cacheWrite,
			total: a.cost.total + sign * b.cost.total,
		},
	};
}

function sessionUsage(sessionManager: SessionManager): Usage {
	let total = ZERO_USAGE;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "usage") {
			total = addUsage(total, entry.usage);
		} else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			if (entry.message.usage) total = addUsage(total, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			total = addUsage(total, entry.usage);
		}
	}
	return total;
}

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
	const messages = session.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function billTree(child: Child): Usage {
	const total = sessionUsage(child.sessionManager);
	let usage = addUsage(total, child.billed, -1);
	child.billed = total;
	return addUsage(usage, billScope(child.scope));
}

function billScope(scope: Scope): Usage {
	let usage = scope.carry;
	scope.carry = ZERO_USAGE;
	for (const child of scope.children.values()) usage = addUsage(usage, billTree(child));
	return usage;
}

function snapshot(child: Child) {
	const last = lastAssistant(child.session);
	return {
		id: child.id,
		name: child.name,
		status: child.status,
		answer: last ? replyText(last) : "",
		error: child.error ?? null,
		ms: (child.endedAt ?? Date.now()) - child.startedAt,
		cost: sessionUsage(child.sessionManager).cost.total,
		session: child.sessionManager.getSessionFile() ?? null,
	};
}

function findChild(scope: Scope, selector: string, starting: Set<string>): Child {
	const child = scope.children.get(selector) ?? [...scope.children.values()].find((entry) => entry.name === selector);
	if (child) return child;
	if (starting.has(selector)) throw new Error(`rlm: child "${selector}" is still starting; address it after rlm_spawn returns`);
	throw new Error(`rlm: no child "${selector}"`);
}

function beginRun(child: Child): void {
	child.status = "running";
	child.startedAt = Date.now();
	child.endedAt = undefined;
	child.error = undefined;
	if (child.pending) return;
	child.pending = true;
	child.run = new Promise<void>((resolve) => {
		child.endRun = () => {
			child.pending = false;
			resolve();
		};
	});
}

async function withinBudget(work: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		work,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, STOP_BUDGET_MS);
		}),
	]);
	clearTimeout(timer);
}

function finish(child: Child, failure: string | undefined, onSettle: (child: Child) => void): void {
	if (!child.counted) return;
	child.counted = false;
	runningChildren--;
	child.endedAt = Date.now();
	if (child.status !== "cancelled") {
		const last = lastAssistant(child.session);
		if (failure !== undefined) {
			child.status = "failed";
			child.error = failure;
		} else if (last?.stopReason === "stop") {
			child.status = "done";
		} else if (last?.stopReason === "aborted") {
			child.status = "cancelled";
		} else {
			child.status = "failed";
			child.error = last?.errorMessage ?? `stopped: ${last?.stopReason ?? "no reply"}`;
		}
	}
	child.endRun();
	onSettle(child);
}

function prompt(child: Child, text: string, onSettle: (child: Child) => void): void {
	child.session
		.prompt(text, { streamingBehavior: "steer" })
		.catch((error: unknown) => finish(child, errorText(error), onSettle));
}

function abortTree(child: Child): Promise<void> {
	child.scope.closed = true;
	const descendants = [...child.scope.children.values()].map(abortTree);
	if (child.status === "running") {
		child.status = "cancelled";
		void child.session.abort();
	}
	return Promise.all([child.run, ...descendants]).then(() => undefined);
}

function disposeTree(child: Child): void {
	for (const grandchild of child.scope.children.values()) disposeTree(grandchild);
	child.scope.children.clear();
	if (child.counted) {
		child.counted = false;
		runningChildren--;
		child.endRun();
	}
	child.session.dispose();
}

async function waitFor(children: Child[], timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	for (const child of children) child.waiters++;
	try {
		await Promise.race([
			Promise.all(children.map((child) => child.run)),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
			new Promise<void>((_resolve, reject) => {
				onAbort = () => reject(new Error("rlm_collect: aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		for (const child of children) child.waiters--;
	}
}

function notice(child: Child): string {
	const seconds = Math.round(((child.endedAt ?? Date.now()) - child.startedAt) / 1000);
	const last = lastAssistant(child.session);
	const preview = (last ? replyText(last) : "").slice(0, PREVIEW_CHARS);
	const error = child.error ? `: ${child.error}` : "";
	return `rlm child "${child.name}" (${child.id}) ${child.status} after ${seconds}s${error}.\n${preview}\nRead it with tools.rlm_collect({ ids: ["${child.id}"] }).`;
}

function isDepthEntry(data: unknown): data is { depth: number } {
	return typeof data === "object" && data !== null && "depth" in data && Number.isInteger(data.depth);
}

function isIdEntry(data: unknown): data is { next: number } {
	return typeof data === "object" && data !== null && "next" in data && Number.isInteger(data.next);
}

export function createRlmExtension(scope: Scope) {
	return (pi: ExtensionAPI): void => {
		let ui: UI | undefined;
		let nextId = 1;
		const watchers = new Set<() => void>();
		if (!scope.toParent) {
			scope.notify = (message) => ui?.notify(message, "warning");
			scope.changed = () => {
				for (const watch of watchers) watch();
			};
			const view = (ctx: ExtensionContext) => openView(ctx, scope, watchers, { cost: (child) => sessionUsage(child.sessionManager).cost.total });
			pi.registerMessageRenderer<RlmDetails>("rlm", renderRlmMessage);
			pi.registerCommand("rlm", { description: "Show this session's rlm children", handler: (_args, ctx) => view(ctx) });
			pi.registerShortcut(VIEW_KEY, { description: "Show this session's rlm children", handler: (ctx) => view(ctx) });
		}
		const pendingNames = new Set<string>();
		const billIfLive = (signal: AbortSignal | undefined) => (signal?.aborted ? undefined : billScope(scope));
		const childNote =
			scope.depth > 0
				? ` This session is itself a child at depth ${scope.depth}; report to the session that spawned you with to: "parent".`
				: "";

		const updateStatus = () => scope.changed();

		const onSettle = (child: Child) => {
			appendTrace(scope.notify, child.tracePath, {
				v: 1,
				t: "settle",
				id: child.id,
				ts: new Date().toISOString(),
				ms: (child.endedAt ?? Date.now()) - child.startedAt,
				status: child.status,
				usage: sessionUsage(child.sessionManager),
				error: child.error ?? null,
			});
			updateStatus();
			if (scope.closed || child.waiters > 0 || child.status === "cancelled") return;
			const last = lastAssistant(child.session);
			const details: RlmDetails = {
				kind: "done",
				id: child.id,
				name: child.name,
				status: child.status,
				ms: (child.endedAt ?? Date.now()) - child.startedAt,
				cost: sessionUsage(child.sessionManager).cost.total,
				answer: (last ? replyText(last) : "").slice(0, ANSWER_DETAIL_CHARS),
				error: child.error ?? null,
			};
			pi.sendMessage(
				{ customType: "rlm", content: notice(child), display: true, details },
				{ deliverAs: "steer", triggerTurn: true },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			ui = ctx.ui;
			if (!scope.toParent && ctx.mode === "tui") ctx.ui.setWidget("rlm", statusWidget(scope, watchers, rawKeyHint(VIEW_KEY, "view")));
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "custom") continue;
				if (entry.customType === DEPTH_ENTRY && isDepthEntry(entry.data)) scope.depth = entry.data.depth;
				if (entry.customType === ID_ENTRY && isIdEntry(entry.data)) nextId = entry.data.next;
			}
		});

		const sendTo = async (child: Child, message: string): Promise<"steered" | "restarted"> => {
			if (child.scope.closed) throw new Error(`rlm_send: child "${child.name}" is being cancelled`);
			const delivered = child.counted ? "steered" : "restarted";
			if (delivered === "restarted") reserveChild();
			appendTrace(scope.notify, child.tracePath, {
				v: 1,
				t: "send",
				id: child.id,
				ts: new Date().toISOString(),
				delivered,
				message,
			});
			if (delivered === "steered") {
				await child.session.steer(message);
			} else {
				child.counted = true;
				beginRun(child);
				updateStatus();
				prompt(child, message, onSettle);
			}
			return delivered;
		};

		const cancel = async (child: Child) => {
			await withinBudget(abortTree(child));
			const result = snapshot(child);
			scope.carry = addUsage(scope.carry, billTree(child));
			disposeTree(child);
			scope.children.delete(child.id);
			updateStatus();
			return result;
		};

		scope.send = sendTo;
		scope.cancel = cancel;

		pi.on("agent_start", (_event, ctx) => {
			if (scope.closed) ctx.abort();
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			scope.closed = true;
			if (!scope.toParent && ctx.mode === "tui") ctx.ui.setWidget("rlm", undefined);
			const children = [...scope.children.values()];
			await withinBudget(Promise.all(children.map(abortTree)).then(() => undefined));
			for (const child of children) disposeTree(child);
			scope.children.clear();
			ui = undefined;
		});

		pi.registerTool({
			name: "rlm",
			label: "RLM",
			description:
				"One RLM sub-call: send one prompt to a model and get its text reply. The prompt is the whole context: no tools, no history. " +
				"Each call has overhead, so put many items in one prompt and aim for tens of calls, not thousands. " +
				`At most ${MAX_CONCURRENT_CALLS} calls run at once; the rest queue. ` +
				"A call rejects if it fails, is aborted or hits the output limit. Every call is appended to the session's .rlm.ndjson trace. " +
				"For a sub-task that needs tools or several steps, use rlm_spawn.",
			parameters: Type.Object({
				prompt: Type.String({ description: "Everything the model sees besides the system prompt." }),
				system: Type.Optional(Type.String({ description: "System prompt." })),
				model: Type.Optional(MODEL_REF),
			}),
			exposure: "codemode",
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const model = resolveModel(ctx, params.model ?? config.model);
				const tracePath = tracePathOf(ctx);
				await acquireSlot(signal);
				if (signal?.aborted) {
					releaseSlot();
					throw new Error(NOT_STARTED);
				}
				const startedAt = Date.now();
				appendTrace(scope.notify, tracePath, {
					v: 1,
					t: "start",
					id: toolCallId,
					ts: new Date(startedAt).toISOString(),
					provider: model.provider,
					model: model.id,
					system: params.system,
					prompt: params.prompt,
				});
				let message: AssistantMessage;
				try {
					message = await ctx.modelRegistry
						.streamSimple(
							model,
							{ systemPrompt: params.system, messages: [{ role: "user", content: params.prompt, timestamp: startedAt }] },
							{ signal },
						)
						.result();
				} finally {
					releaseSlot();
				}
				const text = replyText(message);
				const { stopReason, usage, errorMessage: error } = message;
				appendTrace(scope.notify, tracePath, {
					v: 1,
					t: "end",
					id: toolCallId,
					ts: new Date().toISOString(),
					ms: Date.now() - startedAt,
					text,
					usage,
					stopReason,
					error: error ?? null,
				});
				const failed = stopReason !== "stop";
				return {
					content: [{ type: "text", text: failed ? `rlm ${stopReason}${error ? `: ${error}` : ""}` : text }],
					details: undefined,
					usage,
					...(failed ? { isError: true } : {}),
				};
			},
		});

		pi.registerTool({
			name: "rlm_spawn",
			label: "RLM spawn",
			description:
				"Start a child agent on a task and return its handle at once. The child is a full pi session with codemode, this session's tools and these rlm tools, " +
				"so it can spawn children of its own down to the configured max depth. It sees only the prompt: include every path and fact it needs. " +
				"When it finishes, this session gets a notice, unless rlm_collect was waiting for it. " +
				`At most ${MAX_RUNNING_CHILDREN} children run at once across the process; beyond that, spawning fails. ` +
				"Every rlm_spawn, rlm_collect, rlm_send and rlm_cancel result carries the cost your children have run up since the last one.",
			parameters: Type.Object({
				prompt: Type.String({ description: "The whole task for the child." }),
				name: Type.Optional(Type.String({ description: "Unique among this session's children. Default: the id." })),
				model: Type.Optional(MODEL_REF),
				thinking: Type.Optional(THINKING),
			}),
			outputSchema: Type.Object({
				id: Type.String(),
				name: Type.String(),
				depth: Type.Number(),
				model: Type.String(),
				session: Type.Union([Type.String(), Type.Null()]),
			}),
			exposure: "codemode",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (scope.closed) throw new Error("rlm_spawn: this session is shutting down");
				if (scope.depth >= config.maxDepth) {
					throw new Error(`rlm_spawn: depth limit reached (depth ${scope.depth}, maxDepth ${config.maxDepth})`);
				}
				const id = `c${nextId}`;
				const name = params.name ?? id;
				if (name !== id && ID_PATTERN.test(name)) {
					throw new Error(`rlm_spawn: names like "${name}" are reserved for ids`);
				}
				if (pendingNames.has(name) || [...scope.children.values()].some((child) => child.name === name)) {
					throw new Error(`rlm_spawn: a child named "${name}" already exists`);
				}
				const model = resolveModel(ctx, params.model ?? config.model);
				nextId++;
				pi.appendEntry(ID_ENTRY, { next: nextId });
				reserveChild();
				pendingNames.add(name);
				let session: AgentSession;
				let sessionManager: SessionManager;
				let childScope: Scope;
				try {
					const parentFile = ctx.sessionManager.getSessionFile();
					sessionManager = parentFile
						? SessionManager.create(ctx.cwd, parentFile.replace(/\.jsonl$/, ""), { parentSession: parentFile })
						: SessionManager.inMemory(ctx.cwd);
					sessionManager.appendCustomEntry(DEPTH_ENTRY, { depth: scope.depth + 1 });
					childScope = {
						depth: scope.depth + 1,
						toParent: (text) => {
							if (scope.closed) throw new Error("rlm_send: the parent session has ended");
							pi.sendMessage(
								{
									customType: "rlm",
									content: `rlm child "${name}" (${id}) says: ${text}`,
									display: true,
									details: { kind: "message", id, name, text } satisfies RlmDetails,
								},
								{ deliverAs: "steer", triggerTurn: true },
							);
						},
						children: new Map(),
						closed: false,
						carry: ZERO_USAGE,
						notify: scope.notify,
						changed: scope.changed,
					};
					const settingsManager = SettingsManager.create(ctx.cwd);
					settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
					const resourceLoader = new DefaultResourceLoader({
						cwd: ctx.cwd,
						agentDir: getAgentDir(),
						settingsManager,
						noExtensions: true,
						noSkills: true,
						extensionFactories: [createCodemodeExtension(), createRlmExtension(childScope)],
					});
					await resourceLoader.reload();
					({ session } = await createAgentSession({
						cwd: ctx.cwd,
						model,
						thinkingLevel: params.thinking ?? pi.getThinkingLevel(),
						resourceLoader,
						settingsManager,
						sessionManager,
						tools: [...new Set([...pi.getActiveTools(), ...RLM_TOOLS])],
					}));
					await session.bindExtensions({});
					if (scope.closed) {
						session.dispose();
						throw new Error("rlm_spawn: this session is shutting down");
					}
				} catch (error) {
					runningChildren--;
					throw error;
				} finally {
					pendingNames.delete(name);
				}
				const tracePath = tracePathOf(ctx);
				const child: Child = {
					id,
					name,
					session,
					sessionManager,
					scope: childScope,
					owner: scope,
					tracePath,
					status: "running",
					counted: true,
					startedAt: Date.now(),
					run: Promise.resolve(),
					endRun: () => {},
					pending: false,
					waiters: 0,
					billed: ZERO_USAGE,
				};
				beginRun(child);
				scope.children.set(id, child);
				const setActivity = (activity: string | undefined) => {
					if (child.activity === activity) return;
					child.activity = activity;
					scope.changed();
				};
				session.subscribe((event) => {
					if (event.type === "tool_execution_start") {
						setActivity(event.parentToolCallId ? `codemode › ${event.toolName}` : event.toolName);
					} else if (event.type === "tool_execution_end") {
						setActivity(event.parentToolCallId ? "codemode" : "thinking");
					} else if (event.type === "turn_start") {
						setActivity("thinking");
					} else if (event.type === "message_update" && event.message.role === "assistant") {
						setActivity("writing");
					}
					if (event.type === "agent_start" && !child.counted && !childScope.closed) {
						child.counted = true;
						runningChildren++;
						beginRun(child);
						updateStatus();
						appendTrace(scope.notify, tracePath, { v: 1, t: "wake", id, ts: new Date().toISOString() });
					} else if (event.type === "agent_settled") {
						child.activity = undefined;
						finish(child, undefined, onSettle);
					}
				});
				appendTrace(scope.notify, tracePath, {
					v: 1,
					t: "spawn",
					id,
					ts: new Date().toISOString(),
					name,
					depth: childScope.depth,
					provider: model.provider,
					model: model.id,
					prompt: params.prompt,
					session: sessionManager.getSessionFile(),
				});
				prompt(child, params.prompt, onSettle);
				updateStatus();
				const handle = {
					id,
					name,
					depth: childScope.depth,
					model: `${model.provider}/${model.id}`,
					session: sessionManager.getSessionFile() ?? null,
				};
				return {
					content: [{ type: "text", text: JSON.stringify(handle) }],
					structuredContent: handle,
					details: undefined,
					usage: billIfLive(signal),
				};
			},
		});

		pi.registerTool({
			name: "rlm_collect",
			label: "RLM collect",
			description:
				"Status and latest reply of this session's children: all of them, or those in ids (ids or names). " +
				"With timeoutMs, first wait up to that long for them to finish; a child finishing while you wait sends no notice.",
			parameters: Type.Object({
				ids: Type.Optional(Type.Array(Type.String())),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			outputSchema: Type.Array(SNAPSHOT),
			exposure: "codemode",
			async execute(_toolCallId, params, signal) {
				const children = params.ids
					? params.ids.map((selector) => findChild(scope, selector, pendingNames))
					: [...scope.children.values()];
				if (params.timeoutMs) await waitFor(children, params.timeoutMs, signal);
				const results = children.map(snapshot);
				return {
					content: [{ type: "text", text: JSON.stringify(results) }],
					structuredContent: results,
					details: undefined,
					usage: billIfLive(signal),
				};
			},
		});

		pi.registerTool({
			name: "rlm_send",
			label: "RLM send",
			description:
				'Message a child by id or name, or "parent" from inside a child. A running child gets it as steering; ' +
				"a finished child starts a new run on it and sends a notice again when done. " +
				`A message to the parent steers its current work, or starts a turn if it is idle.${childNote}`,
			parameters: Type.Object({ to: Type.String(), message: Type.String() }),
			outputSchema: Type.Object({
				delivered: Type.Union([Type.Literal("parent"), Type.Literal("steered"), Type.Literal("restarted")]),
			}),
			exposure: "codemode",
			async execute(_toolCallId, params, signal) {
				let delivered: "parent" | "steered" | "restarted";
				if (params.to === "parent") {
					if (!scope.toParent) throw new Error("rlm_send: this session has no parent in this process");
					scope.toParent(params.message);
					delivered = "parent";
				} else {
					delivered = await sendTo(findChild(scope, params.to, pendingNames), params.message);
				}
				return {
					content: [{ type: "text", text: delivered }],
					structuredContent: { delivered },
					details: undefined,
					usage: billIfLive(signal),
				};
			},
		});

		pi.registerTool({
			name: "rlm_cancel",
			label: "RLM cancel",
			description: `Stop a child and its descendants and forget it, waiting up to ${STOP_BUDGET_MS / 1000} s for them to stop. Its session file stays.`,
			parameters: Type.Object({ id: Type.String({ description: "Id or name." }) }),
			outputSchema: SNAPSHOT,
			exposure: "codemode",
			async execute(_toolCallId, params, signal) {
				const result = await cancel(findChild(scope, params.id, pendingNames));
				const usage = billIfLive(signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, details: undefined, usage };
			},
		});
	};
}

export default function rlmExtension(pi: ExtensionAPI): void {
	createRlmExtension({ depth: 0, children: new Map(), closed: false, carry: ZERO_USAGE, notify: () => {}, changed: () => {} })(pi);
}
