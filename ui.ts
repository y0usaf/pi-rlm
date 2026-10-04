import { homedir } from "node:os";
import {
	DynamicBorder,
	type ExtensionContext,
	keyHint,
	type MessageRenderer,
	rawKeyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	type Focusable,
	Input,
	matchesKey,
	Spacer,
	type TUI,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Child, Scope } from "./index.ts";

export interface DoneDetails {
	kind: "done";
	id: string;
	name: string;
	status: string;
	ms: number;
	cost: number;
	answer: string;
	error: string | null;
}

export interface SaysDetails {
	kind: "message";
	id: string;
	name: string;
	text: string;
}

export type RlmDetails = DoneDetails | SaysDetails;

export interface ViewApi {
	cost: (child: Child) => number;
}

const PREVIEW_LINES = 5;
const CODEMODE_HEADER = /^(Script (completed|failed)|Wall time [\d.]+ seconds|Output:)$/;
const HOME = homedir();
const SAYS_PREVIEW_LINES = 3;
const TICK_MS = 1000;

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function money(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function glyph(status: string, theme: Theme): string {
	if (status === "running") return theme.fg("warning", "●");
	if (status === "done") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	return theme.fg("muted", "⊘");
}

function elapsed(child: Child): number {
	return (child.endedAt ?? Date.now()) - child.startedAt;
}

function* walk(scope: Scope, depth = 0): Generator<{ child: Child; depth: number }> {
	for (const child of scope.children.values()) {
		yield { child, depth };
		yield* walk(child.scope, depth + 1);
	}
}

function moreHint(hidden: number, theme: Theme): string {
	return `${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

function doneBlock(details: DoneDetails, expanded: boolean, pad: number, theme: Theme): Component {
	const bg = details.status === "done" ? "toolSuccessBg" : details.status === "failed" ? "toolErrorBg" : "toolPendingBg";
	const box = new Box(pad, 1, (text) => theme.bg(bg, text));
	const meta = [details.id, details.status, duration(details.ms), details.cost > 0 ? money(details.cost) : ""]
		.filter((part) => part)
		.join(" · ");
	box.addChild(
		new Text(`${theme.fg("toolTitle", theme.bold("rlm"))} ${theme.fg("accent", details.name)} ${theme.fg("muted", meta)}`, 0, 0),
	);
	const error = details.error ? theme.fg("error", details.error) : "";
	const answer = details.answer.trim();
	if (!error && !answer) return box;
	box.addChild(new Spacer(1));
	const lines = [...(error ? [error] : []), ...(answer ? answer.split("\n").map((line) => theme.fg("toolOutput", line)) : [])];
	const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
	const hint = lines.length > shown.length ? `\n${moreHint(lines.length - shown.length, theme)}` : "";
	box.addChild(new Text(shown.join("\n") + hint, 0, 0));
	return box;
}

function saysBlock(details: SaysDetails, expanded: boolean, pad: number, theme: Theme): Component {
	const box = new Box(pad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(
		new Text(
			`${theme.fg("accent", "◆")} ${theme.fg("customMessageLabel", theme.bold(details.name))} ${theme.fg("muted", `${details.id} · message`)}`,
			0,
			0,
		),
	);
	const lines = details.text.trim().split("\n");
	const shown = expanded ? lines : lines.slice(0, SAYS_PREVIEW_LINES);
	const body = shown
		.map((line, index) => `${theme.fg("dim", index === 0 ? "╰─ " : "   ")}${theme.fg("customMessageText", line)}`)
		.join("\n");
	const hint = lines.length > shown.length ? `\n   ${moreHint(lines.length - shown.length, theme)}` : "";
	box.addChild(new Text(body + hint, 0, 0));
	return box;
}

export const renderRlmMessage: MessageRenderer<RlmDetails> = (message, { expanded, outputPad }, theme) => {
	const details = message.details;
	if (!details) return undefined;
	return details.kind === "done"
		? doneBlock(details, expanded, outputPad, theme)
		: saysBlock(details, expanded, outputPad, theme);
};

class Ticker {
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly scope: Scope,
		private readonly tui: TUI,
	) {}

	update(): void {
		const running = [...walk(this.scope)].some(({ child }) => child.status === "running");
		if (running && !this.timer) this.timer = setInterval(() => this.tui.requestRender(), TICK_MS);
		if (!running) this.stop();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

class StatusLine implements Component {
	private readonly ticker: Ticker;
	private readonly watch = () => {
		this.ticker.update();
		this.tui.requestRender();
	};

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly scope: Scope,
		private readonly watchers: Set<() => void>,
		private readonly hint: string,
	) {
		this.ticker = new Ticker(scope, tui);
		watchers.add(this.watch);
		this.ticker.update();
	}

	render(width: number): string[] {
		const nodes = [...walk(this.scope)].map(({ child }) => child);
		if (nodes.length === 0) return [];
		const t = this.theme;
		const running = nodes.filter((child) => child.status === "running");
		const done = nodes.filter((child) => child.status === "done").length;
		const failed = nodes.filter((child) => child.status === "failed").length;
		const tail = [
			done > 0 ? `${t.fg("success", "✓")} ${t.fg("muted", `${done} done`)}` : "",
			failed > 0 ? `${t.fg("error", "✗")} ${t.fg("muted", `${failed} failed`)}` : "",
		].filter((part) => part);
		const hint = ` ${this.hint} ${t.fg("border", "──")}`;
		const lead = `${t.fg("border", "── rlm")} `;
		const join = (parts: string[]) => parts.join(t.fg("dim", " · "));
		const named = running.map((child) => `${t.fg("warning", "●")} ${child.name} ${t.fg("dim", duration(elapsed(child)))}`);
		const counted = running.length > 0 ? [`${t.fg("warning", "●")} ${t.fg("muted", `${running.length} running`)}`] : [];
		const room = width - visibleWidth(lead) - visibleWidth(hint) - 2;
		let body = join([...named, ...tail]);
		if (visibleWidth(body) > room) body = join([...counted, ...tail]);
		const fill = Math.max(1, width - visibleWidth(lead) - visibleWidth(body) - visibleWidth(hint) - 1);
		return [truncateToWidth(`${lead}${body} ${t.fg("border", "─".repeat(fill))}${hint}`, width, "…")];
	}

	invalidate(): void {}

	dispose(): void {
		this.watchers.delete(this.watch);
		this.ticker.stop();
	}
}

export function statusWidget(scope: Scope, watchers: Set<() => void>, hint: string) {
	return (tui: TUI, theme: Theme) => new StatusLine(tui, theme, scope, watchers, hint);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
}

function argSummary(name: string, args: unknown): string {
	if (typeof args === "object" && args !== null) {
		if ("code" in args && typeof args.code === "string") {
			return args.code.split("\n").find((line) => line.trim())?.trim() ?? "";
		}
		if ("prompt" in args && typeof args.prompt === "string") return args.prompt;
		if ("path" in args && typeof args.path === "string") return args.path;
	}
	return name === "codemode" ? "" : JSON.stringify(args ?? {});
}

function transcript(child: Child, width: number, t: Theme): string[] {
	const out: string[] = [];
	const wrap = (text: string, style: (line: string) => string, indent = "") =>
		text
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - visibleWidth(indent))))
			.map((line) => indent + style(line));
	for (const message of child.session.messages) {
		if (message.role === "user") {
			out.push(...wrap(textOf(message.content), (line) => t.fg("muted", line), "› "), "");
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) out.push(...wrap(block.text.trim(), (line) => line), "");
				if (block.type === "toolCall") {
					const summary = argSummary(block.name, block.arguments);
					out.push(truncateToWidth(`${t.fg("toolTitle", `▸ ${block.name}`)} ${t.fg("dim", summary)}`, width, "…"));
				}
			}
		} else if (message.role === "toolResult") {
			const first = textOf(message.content).split("\n").find((line) => line.trim() && !CODEMODE_HEADER.test(line)) ?? "";
			out.push(
				truncateToWidth(
					`  ${message.isError ? t.fg("error", "✗") : t.fg("success", "✓")} ${t.fg("dim", first.trim())}`,
					width,
					"…",
				),
				"",
			);
		} else if (message.role === "custom") {
			out.push(...wrap(textOf(message.content).split("\n")[0] ?? "", (line) => t.fg("muted", line), "◆ "), "");
		}
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
}

class View implements Component, Focusable {
	focused = false;
	private readonly ticker: Ticker;
	private readonly watch = () => {
		this.ticker.update();
		this.tui.requestRender();
	};
	private selected = 0;
	private open: Child | undefined;
	private scroll = 0;
	private input: Input | undefined;
	private confirmCancel = false;
	private flash = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly scope: Scope,
		private readonly watchers: Set<() => void>,
		private readonly api: ViewApi,
		private readonly done: () => void,
	) {
		this.ticker = new Ticker(scope, tui);
		watchers.add(this.watch);
		this.ticker.update();
	}

	private nodes() {
		return [...walk(this.scope)];
	}

	private current(): Child | undefined {
		if (this.open) return this.open;
		const nodes = this.nodes();
		this.selected = Math.max(0, Math.min(this.selected, nodes.length - 1));
		return nodes[this.selected]?.child;
	}

	private height(): number {
		return Math.max(6, Math.floor(this.tui.terminal.rows * 0.6) - 8);
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(20, width - 2);
		const body = this.open ? this.renderDetail(this.open, inner) : this.renderList(inner);
		const border = new DynamicBorder((text) => t.fg("borderAccent", text)).render(width)[0];
		return [border, ...body.map((line) => truncateToWidth(` ${line}`, width, "…")), border];
	}

	private header(left: string, right: string, width: number): string {
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "…");
	}

	private footer(keys: string[], width: number): string[] {
		const t = this.theme;
		const lines = [""];
		if (this.input) {
			const prompt = `${t.fg("accent", "send ›")} `;
			const field = this.input.render(Math.max(10, width - visibleWidth(prompt)))[0] ?? "";
			lines.push(prompt + field, "");
		}
		const status = this.confirmCancel ? t.fg("warning", "press c again to cancel it") : this.flash ? t.fg("muted", this.flash) : "";
		if (status) lines.push(status, "");
		lines.push(truncateToWidth(keys.join(t.fg("dim", " · ")), width, "…"));
		return lines;
	}

	private renderList(width: number): string[] {
		const t = this.theme;
		const nodes = this.nodes();
		const running = nodes.filter(({ child }) => child.status === "running").length;
		const total = nodes.reduce((sum, { child }) => sum + this.api.cost(child), 0);
		const summary = nodes.length === 0 ? "no children" : `${nodes.length} children · ${running} running`;
		const lines = [
			this.header(`${t.fg("accent", t.bold("rlm"))}  ${t.fg("muted", summary)}`, total > 0 ? t.fg("muted", money(total)) : "", width),
			"",
		];
		if (nodes.length === 0) {
			lines.push(t.fg("muted", "No children in this session yet."));
		} else {
			this.current();
			const nameWidth = Math.min(28, Math.max(...nodes.map(({ child, depth }) => depth * 2 + visibleWidth(child.name))));
			const rows = nodes.map(({ child, depth }, index) => {
				const selected = index === this.selected;
				const name = `${"  ".repeat(depth)}${child.name}`;
				const padded = truncateToWidth(name, nameWidth, "…") + " ".repeat(Math.max(0, nameWidth - visibleWidth(name)));
				const state = child.status === "running" ? (child.activity ?? "running") : child.status;
				const cost = this.api.cost(child);
				const left = `${selected ? t.fg("accent", "›") : " "} ${glyph(child.status, t)} ${selected ? t.fg("accent", padded) : padded}  ${t.fg("dim", child.id.padEnd(4))} ${t.fg("muted", duration(elapsed(child)).padStart(6))}  ${t.fg(child.status === "failed" ? "error" : "dim", state)}`;
				return this.header(left, cost > 0 ? t.fg("dim", money(cost)) : "", width);
			});
			const room = this.height();
			const start = Math.max(0, Math.min(this.selected - Math.floor(room / 2), rows.length - room));
			lines.push(...rows.slice(start, start + room));
		}
		lines.push(
			...this.footer(
				[
					rawKeyHint("↑↓", "select"),
					rawKeyHint("enter", "open"),
					rawKeyHint("s", "send"),
					rawKeyHint("c", "cancel"),
					rawKeyHint("esc", "close"),
				],
				width,
			),
		);
		return lines;
	}

	private renderDetail(child: Child, width: number): string[] {
		const t = this.theme;
		const state = child.status === "running" ? (child.activity ?? "running") : child.status;
		const cost = this.api.cost(child);
		const meta = [child.id, state, duration(elapsed(child)), cost > 0 ? money(cost) : ""].filter((part) => part).join(" · ");
		const lines = [
			`${glyph(child.status, t)} ${t.fg("accent", t.bold(child.name))} ${t.fg("muted", meta)}`,
			t.fg("dim", truncateToWidth((child.sessionManager.getSessionFile() ?? "in memory").replace(HOME, "~"), width, "…")),
			t.fg("dim", "─".repeat(width)),
		];
		const log = transcript(child, width, t);
		const room = this.height() - (this.input ? 2 : 0);
		const maxScroll = Math.max(0, log.length - room);
		this.scroll = Math.min(this.scroll, maxScroll);
		const end = log.length - this.scroll;
		lines.push(...log.slice(Math.max(0, end - room), end));
		const position = maxScroll > 0 ? [rawKeyHint("↑↓", this.scroll > 0 ? `scroll (${this.scroll} up)` : "scroll")] : [];
		lines.push(
			...this.footer([...position, rawKeyHint("s", "send"), rawKeyHint("c", "cancel"), rawKeyHint("esc", "back")], width),
		);
		return lines;
	}

	handleInput(data: string): void {
		if (this.input) {
			if (matchesKey(data, "escape")) {
				this.input = undefined;
			} else {
				this.input.focused = this.focused;
				this.input.handleInput(data);
			}
			this.tui.requestRender();
			return;
		}
		const child = this.current();
		const cancelKey = data === "c";
		if (!cancelKey) this.confirmCancel = false;
		if (matchesKey(data, "escape") || data === "q") {
			if (this.open && data !== "q") {
				this.open = undefined;
				this.scroll = 0;
			} else {
				this.done();
				return;
			}
		} else if (matchesKey(data, "up") || data === "k") {
			if (this.open) this.scroll += 1;
			else this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			if (this.open) this.scroll = Math.max(0, this.scroll - 1);
			else this.selected += 1;
		} else if (matchesKey(data, "pageUp")) {
			this.scroll += this.height() - 2;
		} else if (matchesKey(data, "pageDown")) {
			this.scroll = Math.max(0, this.scroll - (this.height() - 2));
		} else if (matchesKey(data, "enter") && !this.open && child) {
			this.open = child;
			this.scroll = 0;
		} else if (data === "s" && child) {
			this.startSend(child);
		} else if (cancelKey && child) {
			if (!this.confirmCancel) {
				this.confirmCancel = true;
			} else {
				this.confirmCancel = false;
				this.flash = `cancelling ${child.name}…`;
				child.owner.cancel?.(child).then(
					() => {
						this.flash = `cancelled ${child.name}`;
						if (this.open === child) this.open = undefined;
						this.tui.requestRender();
					},
					(error: unknown) => {
						this.flash = error instanceof Error ? error.message : String(error);
						this.tui.requestRender();
					},
				);
			}
		}
		this.tui.requestRender();
	}

	private startSend(child: Child): void {
		const input = new Input();
		input.focused = this.focused;
		input.onSubmit = (value) => {
			this.input = undefined;
			const message = value.trim();
			if (!message) return;
			child.owner.send?.(child, message).then(
				(delivered) => {
					this.flash = `${delivered} ${child.name}`;
					this.tui.requestRender();
				},
				(error: unknown) => {
					this.flash = error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
				},
			);
		};
		input.onEscape = () => {
			this.input = undefined;
			this.tui.requestRender();
		};
		this.input = input;
	}

	invalidate(): void {}

	dispose(): void {
		this.watchers.delete(this.watch);
		this.ticker.stop();
	}
}

export async function openView(ctx: ExtensionContext, scope: Scope, watchers: Set<() => void>, api: ViewApi): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("rlm: the children view needs the interactive TUI", "warning");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new View(tui, theme, scope, watchers, api, () => done()));
}
