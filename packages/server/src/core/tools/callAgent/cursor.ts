import '../../../lib/configure-ripgrep';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, type ModelSelection, type McpServerConfig } from '@cursor/sdk';
import { type CallAgentArgs, DeliverableRecord, SubAgentTaskRecord } from '@meeting-agent/protocol';
import { isRecord } from '../../../lib/is-record';
import type { AppendLog } from '../../resources';
import type { CallAgentFn } from './mock';

/**
 * call_agent (real) — the Cursor SDK sub-agent behind the same contract as the mock.
 *
 * It hands `args.task` to a local Cursor agent (composer-2.5, fast mode) scoped to a working tree,
 * streams its progress, and registers the findings HTML the agent WRITES as a deliverable.
 *
 * NO FALLBACKS (by design — Jacob's directive). A run either produces a real findings file or it does
 * not. On any failure (timeout, SDK error, the agent finished without writing findings, a non-finished
 * status) we emit a terminal `error` on the <sub_agents> resource and return `null` — we never
 * fabricate a placeholder deliverable. The brain observes the error via the resource and moves on.
 *
 * Invariants:
 *   - It NEVER throws. Every failure path resolves to `null` (and an `error` status), never an
 *     exception out of the CallAgentFn — the orchestrator dispatch must not crash on a sub-agent.
 *   - A returned DeliverableRecord ALWAYS points at a real, non-empty, agent-written HTML file on disk.
 *   - A wall-clock timeout bounds the run; on timeout we best-effort `run.cancel()` and return null.
 *
 * The SDK is INJECTABLE (an `agentFactory` seam mirroring vad.ts's engine seam): production omits it
 * (the real `Agent.create` is used); a unit test passes a fake agent/run so the module can be
 * exercised with no network and no Cursor credits.
 *
 * Ripgrep: `./configure-ripgrep-shim` is imported on the FIRST line, before `@cursor/sdk`, so the
 * SDK's local file-search tools find ripgrep at module-init. Without it real research hangs.
 */

/** Default model id. Cursor.models.list() → `composer-2.5` (aliases composer-latest/composer/composer-2-5). */
const DEFAULT_MODEL = 'composer-2.5';
/** "Fast mode" is a model VARIANT param, not part of the id (catalog: `Composer 2.5{fast=true}`). */
const FAST_MODE_PARAMS: ModelSelection['params'] = [{ id: 'fast', value: 'true' }];
/**
 * Wall-clock budget for one sub-agent run. Default 10 minutes (Jacob's directive; overridable via
 * main.ts's CURSOR_AGENT_TIMEOUT_MS). Even a trivial investigation measured ~60s with composer-2.5
 * fast, so the old 90s cap killed legitimate multi-step work; a real codebase dig can take minutes.
 * The heartbeat never blocks on this regardless (call_agent is fire-and-forget), and whatever the run
 * settles to — findings or a timeout `error` — wakes the brain via the <sub_agents> resource.
 */
const DEFAULT_TIMEOUT_MS = 600_000;
/** How much of the agent's final summary text we keep for the deliverable `description` field. */
const DESCRIPTION_MAX = 200;
/**
 * Bound on the streamed-progress tail we carry on each sub-agent status record. The Cursor agent can
 * emit hundreds of lines; the brain only needs the most recent few to know what it's doing right now,
 * and an unbounded array would balloon every status snapshot the heartbeat renders each beat.
 */
const PROGRESS_TAIL = 12;

/**
 * The slice of `@cursor/sdk`'s `Run` we drive. Declaring a narrow structural interface (rather than
 * importing the full `Run`) is what lets a test pass a hand-rolled fake without an assertion: the
 * real `Run` is structurally assignable to this, and so is a minimal stub.
 */
export interface CursorRun {
  stream(): AsyncGenerator<unknown, void>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
  supports(operation: 'stream' | 'wait' | 'cancel' | 'conversation'): boolean;
}

/** The fields of `@cursor/sdk`'s `RunResult` we consume (a superset is fine — extra fields ignored). */
export interface CursorRunResult {
  status: 'finished' | 'error' | 'cancelled';
  result?: string;
  durationMs?: number;
}

/** The slice of `@cursor/sdk`'s `SDKAgent` we drive: send a prompt, get a run, close on cleanup. */
export interface CursorAgent {
  send(prompt: string): Promise<CursorRun>;
  close(): void;
}

/** Options the factory receives — the subset of `AgentOptions` we set for a local triage agent. */
export interface CursorAgentFactoryOptions {
  apiKey: string;
  name: string;
  /** Full model selection: `{ id, params }` (id + the fast-mode variant param). */
  model: ModelSelection;
  cwd: string;
  /** MCP servers exposed to the agent (e.g. Datadog), keyed by server name. Omitted ⇒ none. */
  mcpServers?: Record<string, McpServerConfig>;
}

/** Injection seam: how to build a Cursor agent. Defaults to the real `Agent.create` (local mode). */
export type CursorAgentFactory = (opts: CursorAgentFactoryOptions) => Promise<CursorAgent>;

export interface CallAgentCursorDeps {
  deliverables: AppendLog<DeliverableRecord>;
  /**
   * The sub-agent-task resource. We append status here (running → progress → done/error) so the
   * heartbeat can OBSERVE the run live instead of blocking on it. Optional so the existing unit test
   * (no live status surface) still constructs this without it; when omitted, status is not emitted.
   */
  subAgents?: AppendLog<SubAgentTaskRecord>;
  /** Directory the findings HTML is written into. Resolved to an ABSOLUTE path (see below). */
  outDir: string;
  /** Cursor account API key (`crsr_...`). Passed explicitly so we don't rely on ambient env here. */
  apiKey: string;
  /** Working directory the local agent investigates (and ripgrep-searches). */
  cwd: string;
  /** Cursor model id; defaults to `composer-2.5`. Fast mode is always applied as a variant param. */
  model?: string;
  /**
   * MCP servers the sub-agent may use (e.g. Datadog), keyed by name. Passed straight to the Cursor
   * agent; its tools auto-register and the model can call them. Omitted ⇒ the sub-agent has none.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /** Wall-clock budget per call in ms; defaults to 90_000. */
  timeoutMs?: number;
  /** Live progress sink for streamed events; defaults to `console.log` with a `[cursor]` prefix. */
  onProgress?: (line: string) => void;
  /** Injection seam for the SDK (tests pass a fake); defaults to the real `Agent.create`. */
  agentFactory?: CursorAgentFactory;
}

/**
 * The default agent factory: a thin wrapper over the real `Agent.create`. `model` is REQUIRED for
 * local agents and carries the fast-mode variant param. `local.cwd` scopes the agent (and ripgrep) to
 * the working tree we want triaged. The returned `SDKAgent` satisfies {@link CursorAgent} structurally.
 */
function defaultAgentFactory(opts: CursorAgentFactoryOptions): Promise<CursorAgent> {
  return Agent.create({
    apiKey: opts.apiKey,
    name: opts.name,
    model: opts.model,
    local: { cwd: opts.cwd },
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
  });
}

/**
 * Build the Datadog MCP server config (shelfio `datadog-mcp` over stdio — the SAME server the team
 * uses in Claude Code) from env. Returns `{ datadog: ... }` only when both keys are present, so the
 * sub-agent simply has no Datadog tools when creds are unset (no error). The keys are passed into the
 * spawned server's OWN env; `uvx` must be on PATH where the brain runs (the Mac host). DD_SITE defaults
 * to us5 to match the team account.
 */
export function datadogMcpFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, McpServerConfig> | undefined {
  const DD_API_KEY = env.DD_API_KEY;
  const DD_APP_KEY = env.DD_APP_KEY;
  if (!DD_API_KEY || !DD_APP_KEY) return undefined;
  return {
    datadog: {
      type: 'stdio',
      command: 'uvx',
      args: ['--from', 'git+https://github.com/shelfio/datadog-mcp.git', 'datadog-mcp'],
      env: { DD_API_KEY, DD_APP_KEY, DD_SITE: env.DD_SITE ?? 'us5.datadoghq.com' },
    },
  };
}

/**
 * Build the prompt. This wrapper carries ONLY the OUTPUT CONTRACT the server depends on: write the
 * findings as a markdown document to an EXACT absolute path we control (so we can read it back
 * deterministically) and put a one-paragraph summary in the run result (the deliverable description).
 * It says NOTHING about HOW to investigate, how deep to dig, or how to ground the findings — that
 * substance lives entirely in `task`, which the brain (Gemma) authors per call (see identity.ts "How to
 * brief a sub-agent"). Keeping research craft out of here means ONE place owns it (the brain).
 *
 * Crucially, the findings are NOT shown to anyone — they are written FOR THE BRAIN (Gemma) TO READ.
 * Gemma is the meeting's representative: it reads what its agents found and then decides, for the room,
 * how (or whether) to communicate it — re-expressing it in its own words/visuals, never forwarding this
 * file. So the document is optimized for the READER's comprehension, not for display: dense, structured
 * markdown that may use code blocks, tables, and mermaid diagrams wherever they convey a finding more
 * clearly than prose. There is NO slide budget and NO screenful limit — completeness and clarity win.
 */
function buildPrompt(task: string, findingsPath: string, mcpServerNames: string[] = []): string {
  const mcpNudge = mcpServerNames.includes('datadog')
    ? [
        'You have a Datadog MCP server connected: use its tools to query LIVE operational data —',
        'metrics, logs, monitors, events, incidents — whenever the task involves system health,',
        'errors, performance, or "what is happening in prod". Prefer real Datadog data over guessing,',
        'and chain multiple queries to investigate (e.g. metric spike → correlated logs → the monitor).',
        '',
      ]
    : [];
  return [
    'You are a research sub-agent for a meeting assistant. Carry out the task below against the current',
    'working directory. Your findings are READ BY THE ASSISTANT (not shown to anyone), so write them to',
    'be understood by a reader — completely and clearly. This is NOT a slide; there is no length limit.',
    '',
    ...mcpNudge,
    'Write your findings as a markdown document to EXACTLY this path:',
    `  ${findingsPath}`,
    '',
    'Make the markdown easy to absorb: clear structure, and wherever a visual communicates a finding',
    'better than prose, use it — fenced code blocks for code/snippets, tables for comparisons, and',
    'mermaid diagrams (```mermaid fences) for flows, architecture, or relationships. Use these where they',
    'genuinely aid understanding, not for decoration.',
    '',
    'Be TERSE — dense and high-signal, no filler or padding — but do NOT sacrifice substance: cover',
    'everything the task asked for, grounded in specifics (file paths, line numbers, concrete values).',
    'Completeness and clarity matter more than brevity; just do not waste words.',
    '',
    'Also give a one-paragraph summary of your findings as your final assistant message, so it is',
    'captured in the run result.',
    '',
    'The task itself specifies WHAT to investigate, how deeply, and how to ground it — follow it as given.',
    '',
    'Task:',
    task,
  ].join('\n');
}

/** First `max` chars of the summary, single-lined, for the deliverable `description`. */
function summarize(result: string | undefined, max: number): string {
  const text = (result ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Stream the run's events to `onProgress` as human-readable lines. The `SDKMessage` union is
 * discriminated on `type`; we narrow on it and read fields only inside the matched branch, with
 * `isRecord`/`typeof` guards so a shape drift can never throw out of the stream loop.
 */
async function pumpStream(run: CursorRun, onProgress: (line: string) => void): Promise<void> {
  for await (const ev of run.stream()) {
    if (!isRecord(ev) || typeof ev.type !== 'string') continue;
    switch (ev.type) {
      case 'assistant': {
        const message = isRecord(ev.message) ? ev.message : undefined;
        const content = message && Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            const text = block.text.trim();
            if (text) onProgress(`[cursor] ${text}`);
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            onProgress(`[cursor] · tool_use: ${block.name}`);
          }
        }
        break;
      }
      case 'tool_call': {
        const name = typeof ev.name === 'string' ? ev.name : 'tool';
        const status = typeof ev.status === 'string' ? ev.status : '';
        onProgress(`[cursor] · ${name} (${status})`);
        break;
      }
      case 'thinking': {
        if (typeof ev.text === 'string' && ev.text.trim()) {
          onProgress(`[cursor] (thinking) ${ev.text.trim()}`);
        }
        break;
      }
      case 'status': {
        if (typeof ev.status === 'string') onProgress(`[cursor] status: ${ev.status}`);
        break;
      }
      default:
        break;
    }
  }
}

/** Read the agent-written findings file if it exists and is non-empty; else null (→ failure). */
function readFindingsIfWritten(path: string): string | null {
  try {
    const contents = readFileSync(path, 'utf-8');
    return contents.trim().length > 0 ? contents : null;
  } catch {
    return null;
  }
}

/**
 * Register the agent-written HTML as a `DeliverableRecord` on the deliverables log and return it.
 * Centralised so the (single) success path appends a consistently-shaped record (kind 'html').
 */
function registerDeliverable(
  deps: CallAgentCursorDeps,
  args: { id: string; filePath: string; description: string },
): DeliverableRecord {
  const now = Date.now();
  const record = DeliverableRecord.parse({
    id: args.id,
    kind: 'markdown',
    title: 'Sub-agent findings',
    description: args.description,
    filePath: args.filePath,
    mimeType: 'text/markdown',
    producedAt: now,
    registeredAt: now,
  });
  deps.deliverables.append(record);
  return record;
}

/**
 * Wait for the run with a wall-clock timeout. Returns `{ timedOut: true }` when the budget elapses
 * first, having already attempted `run.cancel()` (guarded by `supports('cancel')`); otherwise returns
 * the terminal `RunResult`. The timer is unref'd so it can never keep the process alive on its own.
 */
async function waitWithTimeout(
  run: CursorRun,
  timeoutMs: number,
): Promise<{ timedOut: false; result: CursorRunResult } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    const outcome = await Promise.race([
      run.wait().then((result): { timedOut: false; result: CursorRunResult } => ({ timedOut: false, result })),
      timeout,
    ]);
    if (outcome.timedOut && run.supports('cancel')) {
      await run.cancel().catch(() => {});
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A small status emitter over the optional `subAgents` log. Each call APPENDS a fresh record keyed by
 * the run `id` (append-only; readers fold latest-per-id). It keeps the live progress tail so a
 * `running` update carries the most-recent {@link PROGRESS_TAIL} streamed lines. A no-op when
 * `subAgents` is absent. Never throws — a status write must never break the never-throw contract.
 */
function createStatusEmitter(
  log: AppendLog<SubAgentTaskRecord> | undefined,
  args: { id: string; task: string; startedAt: number },
) {
  let progress: string[] = [];
  const emit = (record: Partial<SubAgentTaskRecord>): void => {
    if (!log) return;
    try {
      log.append(
        SubAgentTaskRecord.parse({
          id: args.id,
          task: args.task,
          startedAt: args.startedAt,
          status: 'running',
          progress,
          ...record,
        }),
      );
    } catch (err) {
      console.error('[cursor] sub-agent status append failed (ignored):', err);
    }
  };
  return {
    running(): void {
      emit({ status: 'running' });
    },
    /** Push one streamed line onto the bounded tail and emit a fresh running record. */
    note(line: string): void {
      progress = [...progress, line].slice(-PROGRESS_TAIL);
      emit({ status: 'running', progress });
    },
    done(deliverableId: string): void {
      emit({ status: 'done', deliverableId, endedAt: Date.now() });
    },
    error(message: string): void {
      emit({ status: 'error', error: message, endedAt: Date.now() });
    },
  };
}

export function createCallAgentCursor(deps: CallAgentCursorDeps): CallAgentFn {
  const modelId = deps.model ?? DEFAULT_MODEL;
  const model: ModelSelection = { id: modelId, params: FAST_MODE_PARAMS };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseOnProgress = deps.onProgress ?? ((line: string) => console.log(line));
  const agentFactory = deps.agentFactory ?? defaultAgentFactory;
  const mcpServers = deps.mcpServers;
  const mcpServerNames = mcpServers ? Object.keys(mcpServers) : [];
  /** Absolute so the agent (which runs in `cwd`) and the server (which reads here) agree on the path. */
  const outDir = resolve(deps.outDir);

  return async (args: CallAgentArgs): Promise<DeliverableRecord | null> => {
    const id = randomUUID();
    const startedAt = Date.now();
    mkdirSync(outDir, { recursive: true });
    const findingsPath = join(outDir, `FINDINGS-${id}.md`);

    /** Status emitter; the deliverable reuses the SAME id so a `done` record's `deliverableId` matches. */
    const status = createStatusEmitter(deps.subAgents, { id, task: args.task, startedAt });
    /** Every streamed line reaches the terminal AND the sub-agent's progress tail (live visibility). */
    const onProgress = (line: string): void => {
      baseOnProgress(line);
      status.note(line);
    };
    /** Announce the run BEFORE agent.send so the first heartbeat after dispatch sees it running. */
    status.running();

    /** Success: register the agent-written findings + fold a terminal `done` onto the resource. */
    const finishDone = (description: string): DeliverableRecord => {
      const record = registerDeliverable(deps, { id, filePath: findingsPath, description });
      status.done(record.id);
      return record;
    };
    /** Failure: NO deliverable (no fallbacks) — emit a terminal `error` and return null. */
    const fail = (message: string): null => {
      onProgress(`[cursor] sub-agent failed: ${message}`);
      status.error(message);
      return null;
    };

    let agent: CursorAgent | null = null;
    try {
      onProgress(`[cursor] dispatching sub-agent (model=${modelId}, fast) for: ${args.task}`);
      agent = await agentFactory({ apiKey: deps.apiKey, name: 'meeting-triage', model, cwd: deps.cwd, mcpServers });
      const run = await agent.send(buildPrompt(args.task, findingsPath, mcpServerNames));

      /** Stream for live progress WHILE the run executes; swallow stream errors (cosmetic). */
      const streaming = pumpStream(run, onProgress).catch((err: unknown) => {
        console.error('[cursor] stream pump failed (progress only, ignored):', err);
      });

      const waited = await waitWithTimeout(run, timeoutMs);
      /** On a clean finish the stream has ended — drain it. On timeout it may never end; don't await. */
      if (!waited.timedOut) await streaming;

      if (waited.timedOut) {
        return fail(`Timed out after ${timeoutMs}ms`);
      }
      const result = waited.result;
      onProgress(`[cursor] sub-agent ${result.status}${result.durationMs ? ` in ${result.durationMs}ms` : ''}`);
      if (result.status !== 'finished') {
        return fail(`Sub-agent ended with status "${result.status}"`);
      }
      const written = readFindingsIfWritten(findingsPath);
      if (written === null) {
        return fail('Sub-agent finished but wrote no findings file');
      }
      /** Real findings on disk — the only path that registers a deliverable. */
      return finishDone(summarize(result.result, DESCRIPTION_MAX) || `Findings for task: ${args.task}`);
    } catch (err) {
      console.error('[cursor] sub-agent threw (returning null, no fallback):', err);
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      try {
        agent?.close();
      } catch (err) {
        console.error('[cursor] agent.close() failed (ignored):', err);
      }
    }
  };
}
