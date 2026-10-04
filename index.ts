import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerCall } from "./call.ts";
import { registerChildren, rootScope, type Scope, TOOL_NAMES } from "./children.ts";
import { readConfig } from "./config.ts";
import { registerView } from "./view.ts";

function ensureCodemode(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const active = pi.getActiveTools();
		if (active.includes("codemode") || TOOL_NAMES.some((name) => active.includes(name))) return;
		if (pi.getAllTools().some((tool) => tool.name === "codemode")) pi.setActiveTools([...active, "codemode"]);
		if (pi.getActiveTools().includes("codemode")) return;
		ctx.ui.notify(
			"rlm: its tools are only reachable from codemode, which is not active; they cannot be called.",
			"warning",
		);
	});
}

function createRlm(scope: Scope): ExtensionFactory {
	return (pi) => {
		registerCall(pi, scope.tree.config, (message) => scope.tree.notify(message));
		registerChildren(pi, scope, createRlm);
		if (scope.toParent) return;
		registerView(pi, scope);
		ensureCodemode(pi);
	};
}

export default function rlm(pi: ExtensionAPI): void {
	createRlm(rootScope(readConfig()))(pi);
}
