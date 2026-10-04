# AGENTS.md

Maintainer rules for this repository.

- Runtime dependencies stay at zero. Pi-supplied packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`) belong in `peerDependencies` with a `"*"` range and are never bundled.
- UI goes through pi: `ctx.ui` dialogs, `setStatus`, pi's default message rendering and pi's exported components. A
  bespoke widget, renderer or shortcut needs a reason the README can state.
- Config is parsed once, in `config.ts`; an unknown key or a bad value throws.
- Model-facing tool descriptions are the contract. Change them only with the README.
- `biome check .` lints and formats. Check behaviour by loading the working tree into a pi you start yourself:
  `pi -e .`, with `PI_CODING_AGENT_DIR` pointing at a scratch directory.
