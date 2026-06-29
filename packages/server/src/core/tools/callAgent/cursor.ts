import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent } from '@cursor/sdk';
import { type CallAgentArgs, DeliverableRecord, SubAgentTaskRecord } from '@meeting-agent/protocol';
import { isRecord } from '../../../lib/is-record';
import type { AppendLog } from '../../resources';
import type { CallAgentFn } from './mock';

/**
 * call_agent (real) — the Cursor SDK sub-agent behind the same contract as the mock.
 *
 * Same return shape as mock.ts (`CallAgentFn = (args) => Promise<DeliverableRecord>`, appended to
 * the SAME deliverables log), so wiring is a one-line swap in main.ts. What differs: instead of a
 * fixed page, a real Cursor agent investigates `args.task` against the working tree and WRITES its
 * findings to an HTML file we then register as the deliverable.
 *
 * Invariants this module guarantees so the orchestrator dispatch can never crash on a sub-agent:
 *   - It NEVER throws. Any failure (SDK error, timeout, agent didn't write the file) resolves to a
 *     fallback `DeliverableRecord` that still points at a real, renderable HTML file on disk.
 *   - The deliverable's `filePath` always exists: if the agent wrote our exact path we use it; if it
 *     didn't, we synthesize a fallback page from `result.result` (its final summary text).
 *   - A wall-clock timeout bounds the call; on timeout we `run.cancel()` (when supported) and still
 *     produce a deliverable noting the timeout.
 *
 * The SDK is INJECTABLE (an `agentFactory` seam mirroring vad.ts's `VadEngineDeps`): production omits
 * it (the real `Agent.create` is used); a unit test passes a fake agent/run so the module can be
 * exercised with no network and no Cursor credits.
 */

/** Verified against `@cursor/sdk@1.0.22` `messages.d.ts`: the `SDKMessage` union members we read. */
const DEFAULT_MODEL = 'composer-2';
/** Wall-clock budget for one sub-agent run. The dag-runner defaults its per-task timeout to 20 min; */
/** a live conversational triage should be far tighter so the loop isn't held hostage by one call. */
const DEFAULT_TIMEOUT_MS = 180_000;
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
 * real `Run` is structurally assignable to this, and so is a minimal stub. Mirrors how vad.ts
 * declares `VadFrameProcessor` as the slice of vad-node's FrameProcessor it uses.
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
  model: string;
  cwd: string;
}

/** Injection seam: how to build a Cursor agent. Defaults to the real `Agent.create` (local mode). */
export type CursorAgentFactory = (opts: CursorAgentFactoryOptions) => Promise<CursorAgent>;

export interface CallAgentCursorDeps {
  deliverables: AppendLog<DeliverableRecord>;
  /**
   * The sub-agent-task resource. We append status here (running → progress → done/error) so the
   * heartbeat can OBSERVE the run live instead of blocking on it. Optional so the existing unit test
   * (no live status surface) still constructs this without it; when omitted, status is not emitted but
   * every DeliverableRecord behavior is unchanged.
   */
  subAgents?: AppendLog<SubAgentTaskRecord>;
  /** Directory the findings HTML is written into (caller owns its lifecycle). */
  outDir: string;
  /** Cursor account API key (`crsr_...`). Passed explicitly so we don't rely on ambient env here. */
  apiKey: string;
  /** Working directory the local agent investigates (production: `process.cwd()`). */
  cwd: string;
  /** Cursor model id; defaults to `composer-2`. */
  model?: string;
  /** Wall-clock budget per call in ms; defaults to 180_000. */
  timeoutMs?: number;
  /** Live progress sink for streamed events; defaults to `console.log` with a `[cursor]` prefix. */
  onProgress?: (line: string) => void;
  /** Injection seam for the SDK (tests pass a fake); defaults to the real `Agent.create`. */
  agentFactory?: CursorAgentFactory;
}

/** Escape text/attribute content so a task/summary string can never break out of the HTML envelope. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The default agent factory: a thin wrapper over the real `Agent.create`. `model` is REQUIRED for
 * local agents (options.d.ts), and `local.cwd` scopes the agent to the working tree we want triaged.
 * `apiKey` is passed explicitly rather than relying on the ambient `CURSOR_API_KEY`. The returned
 * `SDKAgent` already satisfies {@link CursorAgent} structurally, so no assertion is needed.
 */
function defaultAgentFactory(opts: CursorAgentFactoryOptions): Promise<CursorAgent> {
  return Agent.create({
    apiKey: opts.apiKey,
    name: opts.name,
    model: { id: opts.model },
    local: { cwd: opts.cwd },
  });
}

/**
 * Build the prompt. We instruct the agent to investigate the task AND write a self-contained HTML
 * document to an EXACT path we control (so we can read it deterministically afterwards), and to put
 * its final summary in the run result too (our fallback if the file write doesn't land).
 */
function buildPrompt(task: string, findingsPath: string): string {
  return [
    'You are a research sub-agent embedded in a live meeting assistant. Investigate the task below',
    'against the current working directory and produce a concise, well-organized findings document.',
    '',
    `Write your findings as a SINGLE self-contained, valid, standalone HTML file to EXACTLY this path:`,
    `  ${findingsPath}`,
    'Use proper HTML: a top-level <h1>, section <h2> headings, short paragraphs, and <ul>/<code> where',
    'useful. Cite specifics (file paths, line numbers, concrete values) rather than vague summaries.',
    'Do not include external scripts or network resources — the page must render offline in an iframe.',
    '',
    'Also include a one-paragraph summary of your findings as your final assistant message, so it is',
    'captured in the run result.',
    '',
    'Task:',
    task,
  ].join('\n');
}

/** A renderable fallback page built from the agent's summary text (used when no file was written). */
function fallbackHtml(task: string, summary: string, note: string): string {
  const safeTask = htmlEscape(task);
  const safeSummary = summary.trim().length > 0 ? htmlEscape(summary) : '(no summary was produced)';
  const safeNote = htmlEscape(note);
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Sub-agent findings</title></head>
  <body>
    <h1>Sub-agent findings</h1>
    <p><strong>Task:</strong> ${safeTask}</p>
    <p><em>${safeNote}</em></p>
    <h2>Summary</h2>
    <p>${safeSummary}</p>
  </body>
</html>
`;
}

/** First `max` chars of the summary, single-lined, for the deliverable `description`. */
function summarize(result: string | undefined, max: number): string {
  const text = (result ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Stream the run's events to `onProgress` as human-readable lines. The `SDKMessage` union is
 * discriminated on `type` (messages.d.ts); we narrow on it and read fields only inside the matched
 * branch, with `isRecord`/`typeof` guards so a shape drift can never throw out of the stream loop.
 * Returns nothing — purely for live terminal visibility while the agent works.
 */
async function pumpStream(run: CursorRun, onProgress: (line: string) => void): Promise<void> {
  for await (const ev of run.stream()) {
    if (!isRecord(ev) || typeof ev.type !== 'string') continue;
    switch (ev.type) {
      case 'assistant': {
        /** assistant.message.content is Array<TextBlock | ToolUseBlock>; surface text + tool_use names. */
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
        /** task/system/user/usage/request — not surfaced individually; ignored for progress. */
        break;
    }
  }
}

/** Read the agent-written findings file if it exists and is non-empty; else null (→ fallback). */
function readFindingsIfWritten(path: string): string | null {
  try {
    const contents = readFileSync(path, 'utf-8');
    return contents.trim().length > 0 ? contents : null;
  } catch {
    /** ENOENT (agent didn't write it) or any read error → caller writes the fallback page. */
    return null;
  }
}

/**
 * Register the produced HTML as a `DeliverableRecord` on the deliverables log and return it. Centralised
 * so the success and every fallback path append an identically-shaped record (kind 'html'), exactly
 * like the mock — the only differences are `title`/`description`/`filePath`.
 */
function registerDeliverable(
  deps: CallAgentCursorDeps,
  args: { id: string; filePath: string; description: string },
): DeliverableRecord {
  const now = Date.now();
  const record = DeliverableRecord.parse({
    id: args.id,
    kind: 'html',
    title: 'Sub-agent findings',
    description: args.description,
    filePath: args.filePath,
    mimeType: 'text/html',
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
      /** Best-effort cancel; the agent loop is detached from us once we stop waiting. */
      await run.cancel().catch(() => {});
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A small status emitter over the optional `subAgents` log. Each call APPENDS a fresh record keyed by
 * the run `id` (append-only — the log never mutates prior entries; readers fold latest-per-id). It
 * keeps the live progress tail so a `running` update carries the most-recent {@link PROGRESS_TAIL}
 * streamed lines. A no-op when `subAgents` is absent (the unit-test path). Never throws — a status
 * write must never break the never-throw sub-agent contract.
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
  const model = deps.model ?? DEFAULT_MODEL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseOnProgress = deps.onProgress ?? ((line: string) => console.log(line));
  const agentFactory = deps.agentFactory ?? defaultAgentFactory;

  return async (args: CallAgentArgs): Promise<DeliverableRecord> => {
    const id = randomUUID();
    const startedAt = Date.now();
    mkdirSync(deps.outDir, { recursive: true });
    const findingsPath = join(deps.outDir, `FINDINGS-${id}.html`);

    /**
     * Status emitter over the subAgents resource. We mint the run `id` here and reuse the SAME id for
     * the deliverable, so the terminal `done` record's `deliverableId` matches the produced artifact.
     */
    const status = createStatusEmitter(deps.subAgents, { id, task: args.task, startedAt });
    /**
     * Wrap onProgress so every streamed line both reaches the terminal (live visibility, unchanged)
     * AND lands in the sub-agent's progress tail — that tail is what the heartbeat renders and the web
     * shows, so the brain can see what the sub-agent is doing without blocking on it (Task #18).
     */
    const onProgress = (line: string): void => {
      baseOnProgress(line);
      status.note(line);
    };
    /** Announce the run BEFORE agent.send so the very first heartbeat after dispatch sees it running. */
    status.running();

    /**
     * Register the deliverable AND fold the matching terminal status onto the subAgents log in one
     * step, so every return path keeps the resource consistent with what was produced. `done` for a
     * successful run, `error` for the timeout/failure paths (the deliverable is still renderable — the
     * never-throw contract — but the brain should see the run did not complete cleanly).
     */
    const finishDone = (description: string): DeliverableRecord => {
      const record = registerDeliverable(deps, { id, filePath: findingsPath, description });
      status.done(record.id);
      return record;
    };
    const finishError = (description: string, message: string): DeliverableRecord => {
      const record = registerDeliverable(deps, { id, filePath: findingsPath, description });
      status.error(message);
      return record;
    };

    /**
     * One agent, created per call and closed in `finally` (the dag-runner's per-task pattern). The
     * whole body is wrapped so that NOTHING — SDK construction, streaming, timeout, file IO — can
     * throw out of the CallAgentFn: every failure path still appends a renderable fallback deliverable.
     */
    let agent: CursorAgent | null = null;
    try {
      onProgress(`[cursor] dispatching sub-agent (model=${model}) for: ${args.task}`);
      agent = await agentFactory({ apiKey: deps.apiKey, name: 'meeting-triage', model, cwd: deps.cwd });
      const run = await agent.send(buildPrompt(args.task, findingsPath));

      /**
       * Stream for live terminal progress WHILE the run executes. We don't await the stream pump
       * before waiting: `wait()` is the source of truth for terminal state, and we don't want a
       * never-ending stream (or a stream error) to block the timeout. We swallow stream errors —
       * they're cosmetic; the deliverable is built from the file + `wait()` result regardless.
       */
      const streaming = pumpStream(run, onProgress).catch((err: unknown) => {
        console.error('[cursor] stream pump failed (progress only, ignored):', err);
      });

      const waited = await waitWithTimeout(run, timeoutMs);
      /**
       * When the run reached a terminal state on its own, its stream ends too — drain it so all
       * progress lines are emitted before we read the file. On TIMEOUT the stream may never end (the
       * run is detached/cancelled), so we do NOT await it there; we leave it to settle in the
       * background (it already has its own `.catch`) rather than block the loop past the budget.
       */
      if (!waited.timedOut) await streaming;

      if (waited.timedOut) {
        onProgress(`[cursor] sub-agent timed out after ${timeoutMs}ms — cancelled`);
        const written = readFindingsIfWritten(findingsPath);
        if (written !== null) {
          /** It managed to write the file before the timeout — use it (still flagged as error). */
          return finishError(
            `Timed out, but findings were written for task: ${args.task}`,
            `Timed out after ${timeoutMs}ms`,
          );
        }
        writeFileSync(
          findingsPath,
          fallbackHtml(args.task, '', `The sub-agent timed out after ${timeoutMs}ms before completing.`),
          'utf-8',
        );
        return finishError(
          `Sub-agent timed out for task: ${args.task}`,
          `Timed out after ${timeoutMs}ms`,
        );
      }

      const result = waited.result;
      onProgress(`[cursor] sub-agent ${result.status}${result.durationMs ? ` in ${result.durationMs}ms` : ''}`);

      const written = readFindingsIfWritten(findingsPath);
      if (written !== null) {
        /** The agent wrote our exact path — register that file directly. */
        return finishDone(
          summarize(result.result, DESCRIPTION_MAX) || `Findings for task: ${args.task}`,
        );
      }

      /**
       * The agent finished but didn't write the file (or wrote it empty) — synthesize a renderable
       * fallback from its summary text so the deliverable still points at real HTML on disk.
       */
      const note =
        result.status === 'finished'
          ? 'The sub-agent did not write a findings file; this page was built from its summary.'
          : `The sub-agent ended with status "${result.status}"; this page was built from its summary.`;
      writeFileSync(findingsPath, fallbackHtml(args.task, result.result ?? '', note), 'utf-8');
      return finishDone(
        summarize(result.result, DESCRIPTION_MAX) || `Findings for task: ${args.task}`,
      );
    } catch (err) {
      /**
       * Last-resort fallback: the dispatch must not crash on a sub-agent failure. Log the cause and
       * return a renderable deliverable describing the failure (file written best-effort; if even that
       * fails the record still parses, just without a usable filePath — never a throw).
       */
      console.error('[cursor] sub-agent failed (returning fallback deliverable):', err);
      const message = err instanceof Error ? err.message : String(err);
      try {
        writeFileSync(
          findingsPath,
          fallbackHtml(args.task, '', `The sub-agent failed before producing findings: ${message}`),
          'utf-8',
        );
      } catch {
        /** Even the fallback write failed (e.g. unwritable outDir) — still return a parseable record. */
      }
      return finishError(`Sub-agent failed for task: ${args.task}`, message);
    } finally {
      /** Always release the agent's resources, success or failure (the dag-runner's `finally` close). */
      try {
        agent?.close();
      } catch (err) {
        console.error('[cursor] agent.close() failed (ignored):', err);
      }
    }
  };
}
