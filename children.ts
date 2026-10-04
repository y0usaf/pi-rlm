import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	type ExtensionToolContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Config, errorText, MODEL_REF, NAMESPACE, replyText, resolveModel } from "./config.ts";

export const TOOL_NAMES = ["rlm", "rlm_spawn", "rlm_collect", "rlm_send", "rlm_cancel"];
const STOP_BUDGET_MS = 5000;
const PREVIEW_CHARS = 300;
const DEPTH_ENTRY = "rlm-depth";
const ID_ENTRY = "rlm-next-id";
const ID_PATTERN = /^c\d+$/;
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Status = "running" | "done" | "failed" | "cancelled";
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface Tree {
	config: Config;
	changed: () => void;
	notify: (message: string) => void;
}

export interface Scope {
	tree: Tree;
	depth: number;
	children: Map<string, Child>;
	closed: boolean;
	carry: Usage;
	settle: (child: Child) => void;
	toParent: ((text: string) => void) | undefined;
}

export interface Child {
	id: string;
	name: string;
	session: AgentSession;
	sessionManager: SessionManager;
	scope: Scope;
	owner: Scope;
	status: Status;
	active: boolean;
	startedAt: number;
	endedAt: number | undefined;
	error: string | undefined;
	run: Promise<void>;
	endRun: () => void;
	waiters: number;
	billed: Usage;
}

interface Opened {
	session: AgentSession;
	sessionManager: SessionManager;
}

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
	status: Type.Union([
		Type.Literal("running"),
		Type.Literal("done"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	]),
	answer: Type.String({ description: "The child's latest reply; final once status is not running." }),
	error: Type.Union([Type.String(), Type.Null()]),
	ms: Type.Number(),
	cost: Type.Number(),
	session: Type.Union([Type.String(), Type.Null()]),
});

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
		} else if (
			entry.type === "message" &&
			(entry.message.role === "assistant" || entry.message.role === "toolResult")
		) {
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
	const usage = addUsage(total, child.billed, -1);
	child.billed = total;
	return addUsage(usage, billScope(child.scope));
}

function billScope(scope: Scope): Usage {
	let usage = scope.carry;
	scope.carry = ZERO_USAGE;
	for (const child of scope.children.values()) usage = addUsage(usage, billTree(child));
	return usage;
}

export function* walk(scope: Scope, depth = 0): Generator<{ child: Child; depth: number }> {
	for (const child of scope.children.values()) {
		yield { child, depth };
		yield* walk(child.scope, depth + 1);
	}
}

export function snapshot(child: Child) {
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

function notice(child: Child): string {
	const seconds = Math.round(((child.endedAt ?? Date.now()) - child.startedAt) / 1000);
	const last = lastAssistant(child.session);
	const answer = last ? replyText(last).trim() : "";
	const preview = answer.length > PREVIEW_CHARS ? `${answer.slice(0, PREVIEW_CHARS)}…` : answer;
	const error = child.error ? `: ${child.error}` : "";
	return [
		`rlm child "${child.name}" (${child.id}) ${child.status} after ${seconds}s${error}.`,
		preview,
		`Read it with tools.rlm_collect({ ids: ["${child.id}"] }).`,
	]
		.filter((part) => part)
		.join("\n\n");
}

function startRun(child: Child): void {
	child.active = true;
	child.status = "running";
	child.startedAt = Date.now();
	child.endedAt = undefined;
	child.error = undefined;
	child.run = new Promise<void>((resolve) => {
		child.endRun = () => resolve();
	});
}

function stopRun(child: Child): void {
	child.active = false;
	child.endedAt = Date.now();
	child.endRun();
}

function finish(child: Child, failure: string | undefined): void {
	if (!child.active) return;
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
	stopRun(child);
	child.owner.settle(child);
}

function prompt(child: Child, text: string): void {
	child.session
		.prompt(text, { streamingBehavior: "steer" })
		.catch((error: unknown) => finish(child, errorText(error)));
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
	if (child.active) stopRun(child);
	child.session.dispose();
}

async function withinBudget(work: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		work,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, STOP_BUDGET_MS);
		}),
	]);
	clearTimeout(timer);
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

export async function send(child: Child, message: string): Promise<"steered" | "restarted"> {
	if (child.scope.closed) throw new Error(`rlm_send: child "${child.name}" is being cancelled`);
	if (child.active) {
		await child.session.steer(message);
		return "steered";
	}
	startRun(child);
	child.owner.tree.changed();
	prompt(child, message);
	return "restarted";
}

export async function cancel(child: Child) {
	await withinBudget(abortTree(child));
	const result = snapshot(child);
	const owner = child.owner;
	owner.carry = addUsage(owner.carry, billTree(child));
	disposeTree(child);
	owner.children.delete(child.id);
	owner.tree.changed();
	return result;
}

function findChild(scope: Scope, selector: string, starting: Set<string>): Child {
	const child = scope.children.get(selector) ?? [...scope.children.values()].find((entry) => entry.name === selector);
	if (child) return child;
	if (starting.has(selector))
		throw new Error(`rlm: child "${selector}" is still starting; address it after rlm_spawn returns`);
	throw new Error(`rlm: no child "${selector}"`);
}

function isDepthEntry(data: unknown): data is { depth: number } {
	return typeof data === "object" && data !== null && "depth" in data && Number.isInteger(data.depth);
}

function isIdEntry(data: unknown): data is { next: number } {
	return typeof data === "object" && data !== null && "next" in data && Number.isInteger(data.next);
}

async function openSession(
	pi: ExtensionAPI,
	ctx: ExtensionToolContext,
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
	scope: Scope,
	extensionFor: (scope: Scope) => ExtensionFactory,
): Promise<Opened> {
	const parentFile = ctx.sessionManager.getSessionFile();
	const sessionManager = parentFile
		? SessionManager.create(ctx.cwd, parentFile.replace(/\.jsonl$/, ""), { parentSession: parentFile })
		: SessionManager.inMemory(ctx.cwd);
	sessionManager.appendCustomEntry(DEPTH_ENTRY, { depth: scope.depth });
	const settingsManager = SettingsManager.create(ctx.cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		extensionFactories: [createCodemodeExtension(), extensionFor(scope)],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model,
		thinkingLevel,
		resourceLoader,
		settingsManager,
		sessionManager,
		tools: [...new Set([...pi.getActiveTools(), "codemode", ...TOOL_NAMES])],
	});
	await session.bindExtensions({});
	return { session, sessionManager };
}

export function rootScope(config: Config): Scope {
	return {
		tree: { config, changed: () => {}, notify: () => {} },
		depth: 0,
		children: new Map(),
		closed: false,
		carry: ZERO_USAGE,
		settle: () => {},
		toParent: undefined,
	};
}

export function registerChildren(
	pi: ExtensionAPI,
	scope: Scope,
	extensionFor: (scope: Scope) => ExtensionFactory,
): void {
	const { config } = scope.tree;
	let nextId = 1;
	const starting = new Set<string>();
	const bill = (signal: AbortSignal | undefined) => (signal?.aborted ? undefined : billScope(scope));
	const childNote = scope.toParent
		? ` This session is itself a child at depth ${scope.depth}; report to the session that spawned you with to: "parent".`
		: "";

	scope.settle = (child) => {
		scope.tree.changed();
		if (scope.closed || child.waiters > 0 || child.status === "cancelled") return;
		pi.sendMessage(
			{ customType: "rlm", content: notice(child), display: true },
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	pi.on("session_start", (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === DEPTH_ENTRY && isDepthEntry(entry.data)) scope.depth = entry.data.depth;
			if (entry.customType === ID_ENTRY && isIdEntry(entry.data)) nextId = entry.data.next;
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		if (scope.closed) ctx.abort();
	});

	pi.on("session_shutdown", async () => {
		scope.closed = true;
		const children = [...scope.children.values()];
		await withinBudget(Promise.all(children.map(abortTree)));
		for (const child of children) disposeTree(child);
		scope.children.clear();
		scope.tree.changed();
	});

	pi.registerTool({
		name: "rlm_spawn",
		label: "RLM spawn",
		namespace: NAMESPACE,
		description:
			"Start a child agent on a task and return its handle at once. The child is a pi session with codemode, " +
			`this session's built-in tools and these rlm tools, so it can spawn children of its own, down to depth ${config.maxDepth}. ` +
			"It sees only the prompt: include every path and fact it needs. " +
			"When it finishes, this session gets a notice, unless rlm_collect was waiting for it.",
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
			if (name !== id && ID_PATTERN.test(name))
				throw new Error(`rlm_spawn: names like "${name}" are reserved for ids`);
			if (starting.has(name) || [...scope.children.values()].some((child) => child.name === name)) {
				throw new Error(`rlm_spawn: a child named "${name}" already exists`);
			}
			const model = resolveModel(ctx, params.model ?? config.model);
			nextId++;
			pi.appendEntry(ID_ENTRY, { next: nextId });
			starting.add(id).add(name);
			const childScope: Scope = {
				tree: scope.tree,
				depth: scope.depth + 1,
				children: new Map(),
				closed: false,
				carry: ZERO_USAGE,
				settle: () => {},
				toParent: (text) => {
					if (scope.closed) throw new Error("rlm_send: the parent session has ended");
					pi.sendMessage(
						{ customType: "rlm", content: `rlm child "${name}" (${id}) says: ${text}`, display: true },
						{ deliverAs: "steer", triggerTurn: true },
					);
				},
			};
			let opened: Opened;
			try {
				opened = await openSession(
					pi,
					ctx,
					model,
					params.thinking ?? pi.getThinkingLevel(),
					childScope,
					extensionFor,
				);
			} finally {
				starting.delete(id);
				starting.delete(name);
			}
			const { session, sessionManager } = opened;
			if (scope.closed) {
				session.dispose();
				throw new Error("rlm_spawn: this session is shutting down");
			}
			const child: Child = {
				id,
				name,
				session,
				sessionManager,
				scope: childScope,
				owner: scope,
				status: "running",
				active: false,
				startedAt: Date.now(),
				endedAt: undefined,
				error: undefined,
				run: Promise.resolve(),
				endRun: () => {},
				waiters: 0,
				billed: ZERO_USAGE,
			};
			startRun(child);
			scope.children.set(id, child);
			session.subscribe((event) => {
				if (event.type === "agent_start" && !child.active && !childScope.closed) {
					startRun(child);
					scope.tree.changed();
				} else if (event.type === "agent_settled") {
					finish(child, undefined);
				}
			});
			prompt(child, params.prompt);
			scope.tree.changed();
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
				usage: bill(signal),
			};
		},
	});

	pi.registerTool({
		name: "rlm_collect",
		label: "RLM collect",
		namespace: NAMESPACE,
		description:
			"Status and latest reply of this session's children: all of them, or those in ids (ids or names). " +
			"With timeoutMs, first wait up to that long for them to finish; a child finishing while you wait sends no notice.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String())),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		outputSchema: Type.Array(SNAPSHOT),
		annotations: { readOnlyHint: true, openWorldHint: false },
		exposure: "codemode",
		async execute(_toolCallId, params, signal) {
			const children = params.ids
				? params.ids.map((selector) => findChild(scope, selector, starting))
				: [...scope.children.values()];
			if (params.timeoutMs) await waitFor(children, params.timeoutMs, signal);
			const results = children.map(snapshot);
			return {
				content: [{ type: "text", text: JSON.stringify(results) }],
				structuredContent: results,
				details: undefined,
				usage: bill(signal),
			};
		},
	});

	pi.registerTool({
		name: "rlm_send",
		label: "RLM send",
		namespace: NAMESPACE,
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
				delivered = await send(findChild(scope, params.to, starting), params.message);
			}
			return {
				content: [{ type: "text", text: delivered }],
				structuredContent: { delivered },
				details: undefined,
				usage: bill(signal),
			};
		},
	});

	pi.registerTool({
		name: "rlm_cancel",
		label: "RLM cancel",
		namespace: NAMESPACE,
		description: `Stop a child and its descendants and forget it, waiting up to ${STOP_BUDGET_MS / 1000} s for them to stop. Its session file stays.`,
		parameters: Type.Object({ id: Type.String({ description: "Id or name." }) }),
		outputSchema: SNAPSHOT,
		exposure: "codemode",
		async execute(_toolCallId, params, signal) {
			const result = await cancel(findChild(scope, params.id, starting));
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result,
				details: undefined,
				usage: bill(signal),
			};
		},
	});
}
