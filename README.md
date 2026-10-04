# pi-rlm

Recursive sub-calls for [pi](https://github.com/earendil-works/pi)'s codemode scripts, after the
[RLM paper](https://arxiv.org/abs/2512.24601): a script can ask a model one question, or start child agents that run
scripts of their own, then message, collect or cancel them.

It won't run a daemon, cap spending, retry failed calls or keep children's file edits apart. Children live in the pi
process that started them and stop with its session.

## Install

```sh
pi install git:github.com/y0usaf/pi-rlm
```

The tools are reachable only from codemode scripts. pi-rlm turns codemode on when it is off, as pi's MCP support does;
a `--tools` list without `codemode` keeps it off, and pi-rlm warns that its tools cannot be called.

## Plain calls

```js
const answers = await Promise.all(chunks.map((chunk) => tools.rlm({ prompt: `${question}\n\n${chunk}` })));
```

`rlm({ prompt, system?, model? })` resolves to the reply text. The prompt is the whole context: no tools, no history. The
call rejects when it fails, is aborted or hits the output limit.

Put many items in each prompt. Left alone, models tend to make one call per item; the RLM paper had to warn Qwen3-Coder
off "thousands of LM subcalls for basic tasks". At most `maxCalls` calls run at once across the process, and the rest
queue. Each call's usage goes on its result, so the session's cost includes it.

## Child agents

```js
await tools.rlm_spawn({ name: "api", prompt: "Review src/api for auth bugs; list file:line." });
const [api] = await tools.rlm_collect({ ids: ["api"], timeoutMs: 600000 });
```

| Tool | What it does |
|---|---|
| `rlm_spawn({ prompt, name?, model?, thinking? })` | Starts a child and resolves at once to `{ id, name, depth, model, session }`. |
| `rlm_collect({ ids?, timeoutMs? })` | Status and latest reply of the given children, or all of them; with `timeoutMs`, waits first. |
| `rlm_send({ to, message })` | Steers a running child or restarts a finished one; from a child, `to: "parent"` messages its parent. |
| `rlm_cancel({ id })` | Stops a child and its descendants, waiting up to 5 s, and forgets it. |

- A child is a pi session in this process with codemode, this session's built-in tools and the rlm tools. It loads no
  other extensions and no skills.
- Its transcript is a normal session file, in a folder named after the parent's session file, with `parentSession` set.
- When a child finishes and no `rlm_collect` was waiting for it, the parent gets an `rlm` message that wakes it if it
  is idle.
- Children can start children down to `maxDepth`. Nothing limits how many run at once.
- Ids look like `c1` and keep counting across resumes of the parent; names of that form are refused.
- Every `rlm_spawn`, `rlm_collect`, `rlm_send` and `rlm_cancel` result carries the cost this session's descendants
  ran up since the last one, so it lands in this session's totals. Cost run up after the last such call stays in the
  children's session files.
- In `pi -p` the process exits when the root's turn ends, so wait for children with `rlm_collect({ timeoutMs })`.

## Watching children

While children run, pi's footer shows `rlm 2 running`. `/rlm` lists this session's children and their descendants;
pick one to watch its transcript live, send it a message or cancel it. Watching needs the terminal UI; messaging and
cancelling also work over RPC.

## Config

`~/.pi/agent/pi-rlm.json` is optional, and so is every key in it. An unknown key or a bad value stops the extension from
loading.

```json
{ "model": "openrouter/qwen/qwen3-30b-a3b-instruct-2507", "maxDepth": 2, "maxCalls": 8, "trace": false }
```

| Key | Default | Meaning |
|---|---|---|
| `model` | the session's model | Default model for plain calls and children, as `provider/id`. |
| `maxDepth` | `2` | How deep children nest: 2 allows children and grandchildren, 0 allows none. |
| `maxCalls` | `8` | Plain calls running at once across the process. |
| `trace` | `false` | Append every plain call to a trace file next to the session. |

## Trace

With `"trace": true`, each plain call appends one line to the session's file with `.jsonl` replaced by `.rlm.ndjson`:

```json
{"id":"<codemode call id>/<n>","ts":"…","ms":812,"provider":"…","model":"…","system":null,"prompt":"…","text":"…","usage":{},"stopReason":"stop","error":null}
```

`id` is pi's nested call id, so its prefix groups one script run. Children trace next to their own session files. A call
that fails before its request is sent writes nothing, and neither does a session without a file (`--no-session`). If a
write fails, tracing stops for that file with one warning. pi reads only `*.jsonl`, so it ignores traces, and deleting
a session leaves its trace behind.

With `t` set to a trace file, these skip a line cut short by a crash:

```sh
jq -nR '[inputs | fromjson?] | sort_by(-.usage.cost.total) | .[:10] | map({id, ms, cost: .usage.cost.total})' "$t"
jq -nR '[inputs | fromjson?] | group_by(.id | sub("/[0-9]+$"; "")) | map({run: (.[0].id | sub("/[0-9]+$"; "")), calls: length, cost: (map(.usage.cost.total) | add)})' "$t"
```

## Limits

- Children share the parent's working directory, so children editing files in parallel can overwrite each other. Give
  them disjoint files or git worktrees.
- Nothing outlives the parent session: exit, `/reload`, `/new`, `/resume` and `/fork` stop every child, and pi waits up
  to 5 s for them.
- There is no budget per child. A stuck child runs until it is cancelled.
- pi cannot withdraw a queued message, so a notice can arrive for a result the script has already read.
- An aborted `rlm_collect` drops the notices of children that finished while it waited; `rlm_collect({})` still lists
  them.
