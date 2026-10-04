import {
	AssistantMessageComponent,
	CustomMessageComponent,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
	keyHint,
	rawKeyHint,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type Child, cancel, type Scope, send, snapshot, walk } from "./children.ts";

const WATCH = "Watch";
const SEND = "Send a message";
const CANCEL = "Cancel";

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function summary(child: Child): string {
	const { id, status, ms, cost } = snapshot(child);
	const money = cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2);
	return [id, status, duration(ms), cost > 0 ? `$${money}` : ""].filter((part) => part).join(" · ");
}

function running(scope: Scope): number {
	let count = 0;
	for (const { child } of walk(scope)) if (child.status === "running") count++;
	return count;
}

function transcript(child: Child, tui: TUI, expanded: boolean): Container {
	const container = new Container();
	const calls = new Map<string, ToolExecutionComponent>();
	const cwd = child.sessionManager.getCwd();
	for (const message of child.session.messages) {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			container.addChild(new Spacer(1));
			container.addChild(new UserMessageComponent(text));
		} else if (message.role === "assistant") {
			container.addChild(new AssistantMessageComponent(message));
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const call = new ToolExecutionComponent(
					block.name,
					block.id,
					block.arguments,
					{},
					child.session.getToolDefinition(block.name),
					tui,
					cwd,
				);
				call.setExpanded(expanded);
				calls.set(block.id, call);
				container.addChild(call);
			}
		} else if (message.role === "toolResult") {
			calls.get(message.toolCallId)?.updateResult(message);
		} else if (message.role === "custom" && message.display) {
			const custom = new CustomMessageComponent(message);
			custom.setExpanded(expanded);
			container.addChild(custom);
		}
	}
	return container;
}

class Watch implements Component {
	private body: Container;
	private expanded = false;
	private scroll = 0;
	private readonly border: DynamicBorder;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly child: Child,
		private readonly close: () => void,
	) {
		this.border = new DynamicBorder((text) => theme.fg("border", text));
		this.body = transcript(child, tui, this.expanded);
		this.unsubscribe = child.session.subscribe((event) => {
			if (event.type !== "message_end" && event.type !== "tool_execution_end" && event.type !== "agent_settled")
				return;
			this.body = transcript(child, tui, this.expanded);
			tui.requestRender();
		});
	}

	private height(): number {
		return Math.max(5, Math.floor(this.tui.terminal.rows * 0.7) - 6);
	}

	render(width: number): string[] {
		const t = this.theme;
		const lines = this.body.render(width);
		const height = this.height();
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - height));
		const end = lines.length - this.scroll;
		const border = this.border.render(width);
		const title = ` ${t.fg("accent", t.bold(this.child.name))} ${t.fg("muted", summary(this.child))}`;
		const hints = [
			rawKeyHint("↑↓", "scroll"),
			keyHint("app.tools.expand", "expand"),
			keyHint("tui.select.cancel", "close"),
		];
		return [
			...border,
			truncateToWidth(title, width),
			...lines.slice(Math.max(0, end - height), end),
			"",
			truncateToWidth(` ${hints.join("  ")}`, width),
			...border,
		];
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) this.scroll++;
		else if (this.keybindings.matches(data, "tui.select.down")) this.scroll = Math.max(0, this.scroll - 1);
		else if (this.keybindings.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			this.body = transcript(this.child, this.tui, this.expanded);
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		this.body.invalidate();
	}

	dispose(): void {
		this.unsubscribe();
	}
}

async function browse(ctx: ExtensionCommandContext, scope: Scope): Promise<void> {
	const nodes = [...walk(scope)];
	if (nodes.length === 0) {
		ctx.ui.notify("rlm: no children in this session", "info");
		return;
	}
	const labels = nodes.map(({ child, depth }) => `${"  ".repeat(depth)}${child.name} · ${summary(child)}`);
	const choice = await ctx.ui.select("rlm children", labels);
	const child = nodes[labels.indexOf(choice ?? "")]?.child;
	if (!child) return;
	const actions = ctx.mode === "tui" ? [WATCH, SEND, CANCEL] : [SEND, CANCEL];
	const action = await ctx.ui.select(`${child.name} · ${summary(child)}`, actions);
	if (action === WATCH) {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => new Watch(tui, theme, keybindings, child, () => done()),
		);
	} else if (action === SEND) {
		const message = (await ctx.ui.input(`Message ${child.name}`))?.trim();
		if (message) ctx.ui.notify(`rlm: ${await send(child, message)} ${child.name}`, "info");
	} else if (action === CANCEL) {
		const stop = await ctx.ui.confirm(
			`Cancel ${child.name}?`,
			"It stops with its descendants and leaves the list. Its session file stays.",
		);
		if (stop) {
			await cancel(child);
			ctx.ui.notify(`rlm: cancelled ${child.name}`, "info");
		}
	}
}

export function registerView(pi: ExtensionAPI, scope: Scope): void {
	pi.on("session_start", (_event, ctx) => {
		scope.tree.changed = () => {
			const count = running(scope);
			ctx.ui.setStatus("rlm", count > 0 ? `rlm ${count} running` : undefined);
		};
		scope.tree.notify = (message) => ctx.ui.notify(message, "warning");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		scope.tree.changed = () => {};
		scope.tree.notify = () => {};
		ctx.ui.setStatus("rlm", undefined);
	});
	pi.registerCommand("rlm", {
		description: "Watch, message or cancel this session's rlm children",
		handler: (_args, ctx) => browse(ctx, scope),
	});
}
