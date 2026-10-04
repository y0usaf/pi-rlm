# pi-rlm

Recursive sub-calls for codemode scripts, after the
[RLM paper](https://arxiv.org/abs/2512.24601) and Prime Agent's `rlm.spawn`.
A script can ask a model one question (`tools.rlm`), or start child agents
that have their own codemode and can start children of their own
(`tools.rlm_spawn`), then message them and collect their answers.

It runs no daemon: children live in this pi process and stop when it exits.
It caps no spending and retries nothing.

Ships in `pi-full`. `--tools` drops every tool it doesn't name, so a run with
`--tools` must list `codemode`, `rlm`, `rlm_spawn`, `rlm_collect`, `rlm_send`
and `rlm_cancel`; `--exclude-tools` leaves them alone.

## Plain calls

```js
const answers = await Promise.all(
  chunks.map((chunk) => tools.rlm({ prompt: `${question}\n\n${chunk}` })),
);
```

- `rlm({ prompt, system?, model? })` returns the reply text. The prompt is the
  whole context: no tools, no history.
- Put many items in each prompt and aim for tens of calls, not thousands.
  Left alone, models tend to make one call per item; the RLM paper had to
  warn Qwen3-Coder off "thousands of LM subcalls for basic tasks".
- At most 8 calls run at once across the process; the rest queue.
- A call rejects if it fails, is aborted or hits the model's output limit
  (`rlm length`). The trace keeps the partial text.
- Each call's usage goes on its result, so the session's cost includes every
  call that finishes before its script does. A call cut off by the end of its
  script or by an abort may go uncounted; its end line in the trace keeps
  whatever usage the provider reported.

## Child agents

```js
const child = await tools.rlm_spawn({ name: "api", prompt: "Review src/api for auth bugs; list file:line." });
const [result] = await tools.rlm_collect({ ids: ["api"], timeoutMs: 600000 });
```

- `rlm_spawn({ prompt, name?, model?, thinking? })` returns
  `{ id, name, depth, model, session }` at once. The child is a pi session in
  this process with codemode, this session's active built-in tools and the
  rlm tools; tools from other extensions are left out.
  Its transcript is a normal session file in a folder named after the parent
  session (`<parent-stem>/`), with `parentSession` set.
- `rlm_collect({ ids?, timeoutMs? })` returns the status and latest reply of
  the children, all of them by default; with `timeoutMs` it waits first.
- `rlm_send({ to, message })` steers a running child, or starts a new run on
  a finished one; it refuses a child that is being cancelled. From a child, `to: "parent"` messages the parent: it steers
  the parent's current work, or starts a turn if the parent is idle.
- `rlm_cancel({ id })` stops a child and its descendants and forgets it. It
  waits up to 5 s for them to stop, then forgets them anyway.
- A child can be addressed once its `rlm_spawn` has returned. Before that,
  `rlm_collect`, `rlm_send` and `rlm_cancel` fail with "still starting".
- Every `rlm_spawn`, `rlm_collect`, `rlm_send` and `rlm_cancel` result carries
  the cost that this session's children and their descendants ran up since
  the last one, so it lands in this session's totals once. A result that
  arrives after its script was aborted carries nothing, and that cost goes on
  the next result instead. Cost run up after a session's last such call stays
  in the children's own session files.
- When a child finishes and no `rlm_collect` was waiting for it, the parent
  gets a notice (custom message `rlm`) that wakes it if it is idle. A child
  woken the same way by its own child's notice runs again, and its parent
  sees it as running and then gets another notice.
- Children can start children down to `maxDepth` (default 2: root, children,
  grandchildren). Each child session stores its depth (`rlm-depth` entry), so
  a reopened child keeps it.
- Spawning or restarting fails while 8 children are running across the
  process. A child woken by a notice runs regardless.
- Ids look like `c1`, keep counting across resumes of the parent session,
  and names of that form are refused.
- Children stop when their parent session ends (exit, `/reload`, `/new`,
  `/resume`, `/fork`); pi waits up to 5 s for them to record it.
- In `pi -p` the process exits when the root's turn ends, so wait for
  children with `rlm_collect({ timeoutMs })` inside the script.
- Children load codemode and pi-rlm only: no other extensions, no skills.

## Limits

- Children share the parent's working directory. Children that edit files in
  parallel can overwrite each other; give them disjoint files or git
  worktrees.
- Nothing outlives the parent session: exit, `/reload`, `/new`, `/resume` and
  `/fork` cancel every child, and nothing brings them back.
- There is no budget per child. A stuck child runs until cancelled, and
  children run without chronobreak.
- pi cannot withdraw a queued message, so a notice can arrive for a result
  the script has already read.
- A `rlm_collect` that is aborted drops the notices of children that
  finished while it waited; `rlm_collect({})` still lists them.
- A message that reaches a child in the instant its run settles waits in the
  child's queue until its next run, as pi's own steering does.

## Config

`~/.pi/agent/pi-rlm.json`, optional:

```json
{ "maxDepth": 2, "model": "openrouter/qwen/qwen3-30b-a3b-instruct-2507" }
```

`model` is the default for plain calls and children; without it they use
the session's model. An invalid file stops the extension from loading.

## Trace

Each session's sub-calls are appended to its session file with `.jsonl`
replaced by `.rlm.ndjson`. A plain call writes a start line when it gets a
slot and an end line when it finishes, fails or is aborted. A child writes
a spawn line, a settle line per run, a send line per message from its parent
and a wake line when a notice or message starts a run on its own:

```json
{"v":1,"t":"start","id":"<codemode call id>/<n>","ts":"…","provider":"…","model":"…","system":"…","prompt":"…"}
{"v":1,"t":"end","id":"<codemode call id>/<n>","ts":"…","ms":812,"text":"…","usage":{…},"stopReason":"stop","error":null}
{"v":1,"t":"spawn","id":"c1","ts":"…","name":"…","depth":1,"provider":"…","model":"…","prompt":"…","session":"…"}
{"v":1,"t":"settle","id":"c1","ts":"…","ms":5230,"status":"done","usage":{…},"error":null}
{"v":1,"t":"send","id":"c1","ts":"…","delivered":"restarted","message":"…"}
{"v":1,"t":"wake","id":"c1","ts":"…"}
```

A settle line's `usage` is the cost recorded in the child's own session so
far, not the run's share: its model calls, its plain calls and the descendant
cost its own rlm results carried. Descendant cost billed by an ancestor first,
or run up after the child's last rlm call, is not in it; `rlm_collect`'s
`cost` field works the same way.

A plain call's `id` is pi's nested call id, so its prefix groups one script
run. End and settle lines carry `error`, which is `null` unless the call or
run failed. Calls that fail before the request is sent (unknown model,
aborted while queued) write nothing. Without a session file (`--no-session`)
nothing is written. If a write fails, tracing stops for that trace file with
one warning in the root session, and calls go on.

pi and `session_search` read only `*.jsonl`, so they ignore traces.
`mv <stem>*` moves a session together with its trace and its children.

With `t` set to a trace file, these skip a line cut short by a crash
(`fromjson?`):

- One object per call or child:
  `jq -nR '[inputs | fromjson?] | group_by(.id) | map(add | del(.t))' "$t"`
- The ten most expensive plain calls:
  `jq -nR '[inputs | fromjson?] | map(select(.t == "end")) | sort_by(-.usage.cost.total) | .[:10] | map({id, ms, cost: .usage.cost.total})' "$t"`
- Calls and children that started and never ended (hung, or the process died):
  `jq -nR '[inputs | fromjson?] | group_by(.id) | map(select(.[-1].t | IN("start", "spawn", "send", "wake")) | .[0])' "$t"`
- Plain calls and cost per model:
  `jq -nR '[inputs | fromjson?] | map(select(.t == "start" or .t == "end")) | group_by(.id) | map(add) | group_by(.provider + "/" + .model) | map({model: (.[0].provider + "/" + .[0].model), calls: length, cost: (map(.usage.cost.total // 0) | add)})' "$t"`
- Each child's latest status and the cost in its own session:
  `jq -nR '[inputs | fromjson?] | map(select(.t == "settle")) | group_by(.id) | map(.[-1] | {id, status, cost: .usage.cost.total})' "$t"`
- Calls and cost per script run:
  `jq -nR '[inputs | fromjson?] | map(select(.t == "end")) | group_by(.id | sub("/[0-9]+$"; "")) | map({run: (.[0].id | sub("/[0-9]+$"; "")), calls: length, cost: (map(.usage.cost.total // 0) | add)})' "$t"`

## Orphans

Deleting a session from `/resume` removes only its `.jsonl`, and nothing here
deletes traces or child folders. To list those whose session id is gone from
every directory under `sessions/`:

```sh
for t in ~/.pi/agent/sessions/*/*.rlm.ndjson ~/.pi/agent/sessions/*/*_*/; do
  [ -e "$t" ] || continue
  id=$(basename "$t" .rlm.ndjson)
  ls ~/.pi/agent/sessions/*/*_"${id#*_}".jsonl >/dev/null 2>&1 || echo "$t"
done
```

To remove them instead of listing them, replace `echo "$t"` with
`rm -r -- "$t"`.

To remove every trace, for example after removing this extension:

```sh
find ~/.pi/agent/sessions -name '*.rlm.ndjson' -delete
```
