# pi-rlm

pi-rlm lets a [pi](https://github.com/earendil-works/pi) codemode script call a model from inside itself: ask one
question, or start child agents that run scripts of their own, then message, collect or cancel them.

It won't run a daemon, cap your spending, retry a failed call or keep children's file edits apart. Children live in the
pi process that started them and stop when its session does.

```sh
pi install git:github.com/y0usaf/pi-rlm
```

## Why

Say you have a two-megabyte deploy log and one question: what broke at 03:12? You can pour the whole thing into the
model's context and hope. It will read the start carefully, skim the middle and invent a confident answer about the end.
Long contexts don't fail loudly; they get vague.

The [RLM paper](https://arxiv.org/abs/2512.24601) suggests something humbler. Keep the long text out of the context, as
a variable in a program, and let the model write code that cuts it up and asks a fresh copy of itself about each piece.
Then ask once more about the answers. No single call ever sees more than it can hold.

pi's codemode already gives the model the program. With the log in a variable, `log`, pi-rlm adds the asking:

```js
const size = 40000;
const chunks = [];
for (let i = 0; i < log.length; i += size) chunks.push(log.slice(i, i + size));

const notes = await Promise.all(
  chunks.map((chunk) => tools.rlm({ prompt: `List every error in this log excerpt, with its timestamp.\n\n${chunk}` })),
);
const answer = await tools.rlm({ prompt: `Which of these errors caused the outage at 03:12?\n\n${notes.join("\n\n")}` });
```

Fifty pieces, fifty quick questions, one summary, and the main session's context holds only the script and the answer.

When a piece of work needs tools and several steps, not one reply, start a child agent instead. A child is a whole pi
session that runs scripts of its own and can start children too.

## The five tools

All five are called from codemode scripts, as `tools.<name>(...)`.

| Tool | What it does |
|---|---|
| `rlm({ prompt, system?, model? })` | Asks a model one question and resolves to its reply text. |
| `rlm_spawn({ prompt, name?, model?, thinking? })` | Starts a child agent and resolves at once to `{ id, name, depth, model, session }`. |
| `rlm_collect({ ids?, timeoutMs? })` | Status and latest reply of the given children, or all of them; with `timeoutMs`, waits first. |
| `rlm_send({ to, message })` | Steers a running child or restarts a finished one; from a child, `to: "parent"` messages its parent. |
| `rlm_cancel({ id })` | Stops a child and its descendants, waiting up to 5 s, and forgets it. |

`model` is an object, `{ provider, id }`, not a string; a ModelInfo from `models.getModelOfType()` works. Left out,
it falls back to `model` in the config file, then to the session's model.

pi-rlm switches codemode on if it is off, as pi's MCP support does. A `--tools` list without `codemode` keeps it off,
and pi-rlm warns that its tools can't be called.

## Plain calls: `rlm`

The prompt is the whole world for that call: no tools, no history, just `prompt` and, if you give one, `system`. The
call rejects when it fails, is aborted or hits the output limit.

Put many items in each prompt. Left to themselves, models love to make one call per item; the RLM paper had to warn
Qwen3-Coder off "thousands of LM subcalls for basic tasks". Aim for tens of calls, not thousands.

At most `maxCalls` plain calls run at once across the whole pi process, children included; the rest wait in line. Each
call's usage rides on its result, so the session's cost counts it.

## Child agents

```js
await tools.rlm_spawn({ name: "api", prompt: "Review src/api for auth bugs; list file:line." });
const [api] = await tools.rlm_collect({ ids: ["api"], timeoutMs: 600000 });
```

A child sees only its prompt, so put every path and fact it needs in there. It gets codemode, the built-in tools this
session has switched on and the five rlm tools. It loads no other extensions and no skills. `thinking` is one of
`off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, and defaults to this session's level.

**Names and ids.** Ids look like `c1`, `c2`, and keep counting when you resume the parent session. A name is
optional, defaults to the id, and must be unique among this session's children; names shaped like ids are refused.
Every tool that takes a child accepts either.

**Hearing back.** When a child finishes, the parent gets an `rlm` message with its status, the first 300 characters
of its reply and a pointer to `rlm_collect`. The message wakes the parent if it is idle. There is no message when an
`rlm_collect` was already waiting for that child, or when the child was cancelled.

**Collecting.** `rlm_collect` resolves to one entry per child:

```json
{ "id": "c1", "name": "api", "status": "done", "answer": "…", "error": null, "ms": 41210, "cost": 0.031, "session": "…" }
```

`status` is `running`, `done`, `failed` or `cancelled`. `answer` is the latest reply, final once the status
is not `running`. With `timeoutMs`, the call waits up to that long and then reports whatever state the children are
in, finished or not.

**Talking.** `rlm_send` resolves to `{ delivered }`: `steered` if the child was running and gets the message
mid-task, `restarted` if it had finished and starts a new run on it (and sends a new notice when done). A child
calls `rlm_send({ to: "parent", message })` to speak up; the parent hears it as steering, or as a new turn if it was
idle.

**Stopping.** `rlm_cancel` stops the child and everything under it, waits up to 5 s, resolves to the child's final
entry and drops it from the list. Its session file stays.

**Depth.** Children can start children down to `maxDepth`. Nothing limits how many run at once.

**Transcripts.** Each child's transcript is an ordinary pi session file, in a folder named after the parent's session
file, with `parentSession` set. A parent without a session file (`--no-session`) gets children without one too, and
`session` is `null`.

**Cost.** Every `rlm_spawn`, `rlm_collect`, `rlm_send` and `rlm_cancel` result carries what this session's
descendants spent since the last such result, so it lands in this session's totals. Whatever they spend after the last
call stays in the children's own session files.

**Print mode.** In `pi -p` the process exits when the root's turn ends, children or not, so wait for them with
`rlm_collect({ timeoutMs })`.

## Watching children

While children run, pi's footer says `rlm 2 running`. `/rlm` lists this session's children and their descendants;
pick one to watch its transcript live, send it a message or cancel it. Watching needs the terminal UI; messaging and
cancelling also work over RPC.

## Config

`~/.pi/agent/pi-rlm.json` is optional, and so is every key in it. An unknown key or a bad value stops the extension
from loading, on purpose: a typo should be loud.

```json
{ "model": "openrouter/qwen/qwen3-30b-a3b-instruct-2507", "maxDepth": 2, "maxCalls": 8, "trace": false }
```

| Key | Default | Meaning |
|---|---|---|
| `model` | the session's model | Default model for plain calls and children, as `"provider/id"`. |
| `maxDepth` | `2` | How deep children nest: 2 allows children and grandchildren, 0 allows none. |
| `maxCalls` | `8` | Plain calls running at once across the process; at least 1. |
| `trace` | `false` | Append every plain call to a trace file next to the session. |

## Trace

With `"trace": true`, each plain call appends one line to the session's file with `.jsonl` replaced by
`.rlm.ndjson`:

```json
{"id":"<codemode call id>/<n>","ts":"…","ms":812,"provider":"…","model":"…","system":null,"prompt":"…","text":"…","usage":{},"stopReason":"stop","error":null}
```

`id` is pi's nested call id, so its prefix groups one script run. Children trace next to their own session files.
Nothing is written for a call that fails before its request goes out, or for a session without a file. If a write
fails, tracing stops for that file with one warning. pi reads only `*.jsonl`, so it ignores traces, and deleting a
session leaves its trace behind.

Two questions worth asking a trace in `$t`: which calls cost the most, and what each script run cost. Both skip a
line a crash cut short.

```sh
jq -nR '[inputs | fromjson?] | sort_by(-.usage.cost.total) | .[:10] | map({id, ms, cost: .usage.cost.total})' "$t"
jq -nR '[inputs | fromjson?] | group_by(.id | sub("/[0-9]+$"; "")) | map({run: (.[0].id | sub("/[0-9]+$"; "")), calls: length, cost: (map(.usage.cost.total) | add)})' "$t"
```

## Sharp edges

- Children share the parent's working directory, so two children editing at once can overwrite each other. Give them
  disjoint files or git worktrees.
- Nothing outlives the parent session. Exit, `/reload`, `/new`, `/resume` and `/fork` stop every child, and pi
  waits up to 5 s for them.
- There is no budget per child. A stuck child runs until someone cancels it.
- pi can't withdraw a queued message, so a notice can arrive for a result the script has already read.
- An aborted `rlm_collect` drops the notices of children that finished while it waited; `rlm_collect({})` still
  lists them.
- `to: "parent"` always means the parent, so a child named `parent` can only be reached by its id.
