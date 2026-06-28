> **STATUS: CURRENT.** `@cursor/sdk` (native TS, Node ≥ 22.13) is the chosen sub-agent engine for
> `call_agent`. This brief was read from `~/repos/cursor-sdk` source and is accurate. See [AGENTS.md](./AGENTS.md).

# Cursor SDK — Usage Brief for `call_agent`

Package: `@cursor/sdk` v1.0.13 (TypeScript/Node ≥18). Source read from
`~/repos/cursor-sdk/dist/esm/*.d.ts` (published type defs = authoritative API)
and `~/repos/cursor-cookbook/sdk/*` (real working examples). Docs:
https://cursor.com/docs/api/sdk/typescript

---

## TL;DR

- **It STREAMS.** `agent.send(prompt)` returns a `Run`; `run.stream()` is an
  `AsyncGenerator<SDKMessage>` that yields incremental events (assistant text
  deltas, thinking, tool calls, status) as the agent works. You get live
  progress. `run.wait()` gives a blocking final `RunResult` with a `result`
  summary string. You can use both: stream for progress, then `wait()` for the
  final result.
- **One-line how:** `const run = await (await Agent.create({apiKey, model:{id:"composer-2"}, local:{cwd:repoPath}})).send(taskDescription)` then iterate `for await (const ev of run.stream())`.
- **Node/TypeScript only.** There is no Python SDK and no first-class CLI binary
  shipped in the package (the cookbook CLI is example code you'd build/run with
  Bun). For a Cerebras Gemma loop in Python, you shell out to a small Node
  script.

---

## Minimal usage example (verified against source + quickstart)

`~/repos/cursor-cookbook/sdk/quickstart/src/index.ts` is the canonical minimal
example. Adapted for our triage use case (task description in, findings to a
markdown file the agent writes itself):

```typescript
import { Agent } from "@cursor/sdk";

async function callAgent(description: string, repoPath: string) {
  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,          // or omit -> reads env automatically
    name: "triage",
    model: { id: "composer-2" },                 // required for local agents
    local: { cwd: repoPath },                     // arbitrary local repo path
  });

  // Tell the agent to write its findings to a file we can screen-share.
  const prompt = [
    "Investigate the following and write your findings as markdown to FINDINGS.md",
    "in the repo root. Be concrete: cite file paths and line numbers.",
    "",
    "Task:",
    description,
  ].join("\n");

  const run = await agent.send(prompt);

  // LIVE PROGRESS: stream events as the agent works.
  for await (const ev of run.stream()) {
    if (ev.type === "assistant") {
      for (const block of ev.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    } else if (ev.type === "tool_call") {
      console.error(`[tool] ${ev.name} (${ev.status})`);
    } else if (ev.type === "status") {
      console.error(`[status] ${ev.status}`);
    }
  }

  const result = await run.wait();   // blocks until terminal; final summary
  agent.close();                     // or: await using agent = ...
  return result;                     // { id, status, result?, durationMs?, ... }
}
```

`Agent.prompt(message, options)` is a one-shot convenience that creates an agent,
runs one prompt, and returns the final `RunResult` — but it gives **no streaming**,
so prefer the explicit `create` + `send` + `stream` form for live progress.

Source: `Agent.create`/`prompt` in `dist/esm/stubs.d.ts:35-73`;
`SDKAgent.send` / `SendOptions` in `dist/esm/agent.d.ts:5-43`;
`Run` (stream/wait/cancel) in `dist/esm/run.d.ts:27-43`;
`SDKMessage` event union in `dist/esm/messages.d.ts:82`.

---

## Answers to each question

### 1. Exact programmatic invocation
- `Agent.create(options: AgentOptions): Promise<SDKAgent>` — `dist/esm/stubs.d.ts:40`
- `agent.send(message: string | SDKUserMessage, options?: SendOptions): Promise<Run>` — `dist/esm/agent.d.ts:12`
- `run.stream(): AsyncGenerator<SDKMessage, void>` and `run.wait(): Promise<RunResult>` — `dist/esm/run.d.ts:32,34`
- One-shot blocking: `Agent.prompt(message, options): Promise<RunResult>` — `dist/esm/stubs.d.ts:48`
- Task description is just the `message` string passed to `send()` / `prompt()`. `AgentOptions` requires `model` for local agents; `apiKey` falls back to `CURSOR_API_KEY`. — `dist/esm/options.d.ts:122-144`
- **No CLI binary.** The package ships only the JS/TS library (`package.json` exports `.` and `./agent`; no `bin` field). The cookbook "coding-agent-cli" is sample app code you build yourself.

### 2. Streams or blocks? → STREAMS (and can block)
`run.stream()` is an async generator yielding `SDKMessage` events live:
`assistant` (text/tool_use blocks), `thinking`, `tool_call` (running/completed/error),
`status` (CREATING/RUNNING/FINISHED/...), `task`, `system`, `user`. — `dist/esm/messages.d.ts:5-82`.
`run.wait()` blocks until terminal and returns `RunResult { status, result?, durationMs?, ... }` — `dist/esm/run.d.ts:19-26`.
`send()` also accepts `onStep`/`onDelta` callbacks for push-style progress — `dist/esm/agent.d.ts:22-27`.
Real streaming loop with per-event handling: `coding-agent-cli/src/agent.ts:165-193, 475-513`.

### 3. Getting findings out cleanly
Three mechanisms, in order of cleanliness for our use case:
- **Agent writes a file directly (recommended).** A local agent operates on `cwd`
  with full file tools, so instruct it in the prompt to write `FINDINGS.md`. You
  read/screen-share that file. The dag-task-runner does exactly this pattern
  (subagents write into `--cwd`) — `dag-task-runner/README.md:199`.
- **Final result string.** `RunResult.result` (also `run.result`) holds the
  agent's final summary text — `dist/esm/run.d.ts:22,40`. Good as a fallback /
  to capture the closing summary.
- **Structured transcript.** `run.conversation(): Promise<ConversationTurn[]>`
  for the full turn-by-turn record — `dist/esm/run.d.ts:33`.
- **Artifacts (cloud-oriented).** `agent.listArtifacts()` / `agent.downloadArtifact(path)`
  return `SDKArtifact { path, sizeBytes, updatedAt }` — `dist/esm/agent.d.ts:16-17`,
  `dist/esm/artifacts.d.ts`.
No built-in "structured JSON findings" schema; markdown-to-file is the idiomatic path.

### 4. Auth
- `CURSOR_API_KEY` env var (keys look like `crsr_...`) — cookbook READMEs
  (`quickstart/README.md:17`, `coding-agent-cli/README.md:18`). Or pass
  `apiKey` explicitly in `AgentOptions` / per-call options; it falls back to
  `process.env.CURSOR_API_KEY` — `dist/esm/agent.d.ts:127`, `dist/esm/options.d.ts:129`.
- It is a **Cursor account API key** minted at cursor.com/dashboard/integrations
  (`cursor-cookbook/README.md:23`). User API keys and service-account keys work;
  Team Admin keys are not yet supported (docs). **Inference always runs through
  Cursor's hosted models and bills your Cursor plan/usage** — there's no
  bring-your-own-LLM-key path (docs).

### 5. Local vs cloud execution
- **Local** (`local: { cwd }`): the agent loop runs inline in your Node process
  against an arbitrary local directory. `cwd` accepts a string or string[]. —
  `dist/esm/options.d.ts:80-90`, quickstart.
- **Cloud** (`cloud: { repos: [{ url, startingRef? }], autoCreatePR?, ... }`):
  runs in a Cursor-hosted (or self-hosted pool) VM that clones a **GitHub** repo;
  requires `remote.origin.url` pointing at GitHub — `dist/esm/options.d.ts:97-121`,
  `coding-agent-cli/src/agent.ts:392-430`.
- **Either way, model inference is Cursor-hosted.** "Local" means file/tool
  execution is local, not that the model runs locally (docs). For our triage of a
  local working tree, **use local mode.**

### 6. Underlying model + configurability
- Configurable and (for local) **required**: `model: { id, params? }` —
  `dist/esm/options.d.ts:42-45,122-128`. Discover valid IDs with
  `Cursor.models.list()` — `dist/esm/stubs.d.ts:88-90`; it returns aliases like
  `composer-latest` (cursor-sdk/README.md).
- Concrete model IDs seen in examples: `composer-2`, `composer-2.5`,
  `gpt-5.3-codex`, `auto-low` (quickstart `index.ts:6`, docs, and
  dag-task-runner model map `README.md:99-105`). Cursor's "Composer" is their own
  coding model; you can also select frontier models (GPT-5.x codex, etc.) via the
  same `id`. The exact catalog varies by account — call `models.list()` to confirm.

### 7. Repo pre-indexing
- **No pre-indexing required.** Local agents work on any `cwd`; cloud agents
  clone on demand (docs §5). The agent explores via file/grep/shell tools at
  runtime, same as Cursor's IDE agent. No separate "index this repo" step in the
  SDK surface.

### 8. Latency / cost for a code-triage task
- **Not specified in source.** Inferred: a focused triage that reads a handful of
  files and writes a markdown summary is typically tens of seconds to a couple of
  minutes; the dag-task-runner defaults a per-task timeout to 20 min and
  stream-idle timeout to 5 min (`dag-task-runner/README.md:137-139`), which bounds
  worst case, and its 6-task demo finished in ~1m47s.
- **Cost:** billed on your Cursor plan exactly like IDE runs — "same pricing,
  request pools, and Privacy Mode rules"; spend appears in the team usage
  dashboard under an SDK tag (docs). No separate SDK surcharge documented. No
  per-call dollar figure available.

### 9. Concurrency / session / cleanup
- **One active run per agent.** Cloud rejects overlapping sends with
  `409 agent_busy`; local can recover a wedged run via `send({ local: { force: true } })`
  — `dist/esm/agent.d.ts:33-43`.
- **Parallelism = multiple agents.** Run independent triage tasks as separate
  `Agent.create` instances concurrently (the dag-runner fans out a rank with
  `Promise.all`); just don't let concurrent local agents write the same files —
  `dag-task-runner/README.md:200-201`.
- **Cleanup:** `agent.close()` or `await using agent = await Agent.create(...)`
  (implements `Symbol.asyncDispose`) — `dist/esm/agent.d.ts:13-15`,
  `coding-agent-cli/src/agent.ts:143-145`.
- **Cancellation:** `run.cancel()` (guard with `run.supports("cancel")`) —
  `dist/esm/run.d.ts:30,35`, `coding-agent-cli/src/agent.ts:147-163`.
- **Resume / list:** `Agent.resume(agentId)`, `Agent.list()`, `Agent.getRun()` —
  `dist/esm/stubs.d.ts:44-52`.

---

## Integration recommendation for our `call_agent(description)` tool

Our loop is Python (Gemma on Cerebras); the SDK is Node-only. Two clean options:

**Recommended: thin Node runner invoked per call.** Ship a small
`run-cursor-agent.mjs` that takes the task description (argv or stdin) + repo path,
does `Agent.create({ local: { cwd }, model: { id: "composer-2" } })`, streams
events to **stderr** (live progress — pipe this to your console/log so you see the
agent working), instructs the agent to write `FINDINGS.md`, then on `run.wait()`
prints the final `result` to **stdout**. The Python tool shells out
(`subprocess.Popen`, read stderr live), and after exit reads `FINDINGS.md` to
screen-share. This keeps streaming + file output + clean separation.

- Local mode (not cloud): triage operates on the working tree directly, no GitHub
  clone, lowest latency.
- Set `CURSOR_API_KEY` in the runner's env.
- Pin a model id (`composer-2` is a safe default; verify with `Cursor.models.list()`
  once at startup).
- Give each call its own agent; `close()` (or `await using`) in a `finally`.
- Add a wall-clock timeout in Python (e.g. 5 min) and `run.cancel()` equivalent by
  killing the child if the loop must move on.

**Alternative:** call `Agent.prompt()` for dead-simple one-shot if you don't need
live streaming — but you lose progress visibility, which is the whole point of the
demo, so don't.

---

## Confidence map

| Claim | Confidence | Basis |
|---|---|---|
| Streams via `run.stream()` async generator; `wait()` blocks for final result | **High** | Source `run.d.ts:32,34`; quickstart + coding-agent-cli loops |
| `Agent.create`/`send`/`prompt` signatures, `AgentOptions`, event types | **High** | Published `.d.ts` source files |
| Auth via `CURSOR_API_KEY` / `apiKey`, Cursor account key | **High** | Source + cookbook READMEs + docs |
| Local works on arbitrary `cwd`, no pre-indexing | **High** | Source `options.d.ts:80-90`; docs |
| Inference is always Cursor-hosted (local ≠ local model) | **High (docs)** | docs.cursor.com; consistent with source |
| Model configurable; ids `composer-2`/`composer-2.5`/`gpt-5.3-codex`/`auto-low` | **High** | Source README, quickstart, dag-runner; exact catalog is account-specific |
| Findings: agent writes file is idiomatic; `result` string + artifacts exist | **High** | Source `run.d.ts`, `artifacts.d.ts`; dag-runner file pattern |
| No Python SDK, no CLI binary in the package | **High** | `package.json` (no `bin`), TS-only dist |
| Cost = same as IDE runs, billed to Cursor plan | **Medium (docs)** | docs; no per-call figure given |
| Latency ~tens of sec to ~2 min for triage | **Low/Inferred** | dag-runner demo ~1m47s for 6 tasks; not specified for single triage |
| Concurrency: 1 run/agent, parallel = many agents | **High** | Source `agent.d.ts`; dag-runner `Promise.all` |

**Unknowns:** exact dollar cost per triage call; whether `composer-2` is in your
specific account's catalog (run `Cursor.models.list()` to confirm); any rate
limits on concurrent local agents (not documented in source).
