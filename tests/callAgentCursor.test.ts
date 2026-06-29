import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliverableRecord } from '@meeting-agent/protocol';
import type {
  DeliverableRecord as DeliverableRecordT,
  SubAgentTaskRecord as SubAgentTaskRecordT,
} from '@meeting-agent/protocol';
import { createAppendLog } from '../packages/server/src/core/resources';
import { foldLatestById } from '../packages/server/src/core/decide';
import {
  createCallAgentCursor,
  type CursorAgent,
  type CursorRun,
  type CursorRunResult,
} from '../packages/server/src/core/tools/callAgent/cursor';

/**
 * cursor.ts — the real Cursor SDK sub-agent, driven with an INJECTED fake agent so the test never
 * touches the network or spends Cursor credits. We assert the NO-FALLBACKS contract: a run either
 * produces a real agent-written findings file (→ a deliverable + `done` status) or it produces nothing
 * (→ NO deliverable + `error` status, and a `null` return). It never fabricates a placeholder, and it
 * never throws out of dispatch.
 */

/** A fake SDKMessage stream — yields the given events, then completes. */
function fakeStream(events: unknown[]): () => AsyncGenerator<unknown, void> {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

interface FakeRunOptions {
  events?: unknown[];
  result?: CursorRunResult;
  /** When set, wait() never resolves (simulates a hung run for the timeout path). */
  hang?: boolean;
  supportsCancel?: boolean;
  onCancel?: () => void;
}

function fakeRun(opts: FakeRunOptions): CursorRun {
  return {
    stream: fakeStream(opts.events ?? []),
    wait: () =>
      opts.hang
        ? new Promise<CursorRunResult>(() => {}) // never resolves
        : Promise.resolve(opts.result ?? { status: 'finished', result: 'done' }),
    cancel: async () => {
      opts.onCancel?.();
    },
    supports: (op) => (op === 'cancel' ? opts.supportsCancel ?? true : true),
  };
}

/** A factory whose `send` returns the run WITHOUT writing a findings file (the no-file / failure path). */
function nonWritingFactory(run: CursorRun, spies: { closed: () => void; prompt: (p: string) => void }) {
  const agent: CursorAgent = {
    send: async (prompt: string) => {
      spies.prompt(prompt);
      return run;
    },
    close: () => spies.closed(),
  };
  return async () => agent;
}

/**
 * A factory whose `send` WRITES the findings file the prompt names (the success path). The prompt
 * carries the absolute FINDINGS-*.md path; we extract the basename and write into `dir` (which is
 * the resolved outDir), exactly where cursor.ts will read it back.
 */
function writingFactory(
  dir: string,
  run: CursorRun,
  spies: { closed: () => void; prompt: (p: string) => void } = { closed: () => {}, prompt: () => {} },
) {
  const agent: CursorAgent = {
    send: async (prompt: string) => {
      spies.prompt(prompt);
      const match = prompt.match(/FINDINGS-[0-9a-f-]+\.md/);
      if (match) writeFileSync(join(dir, match[0]), '# Agent-written findings', 'utf-8');
      return run;
    },
    close: () => spies.closed(),
  };
  return async () => agent;
}

const baseDeps = (outDir: string) => ({
  deliverables: createAppendLog<DeliverableRecordT>(),
  outDir,
  apiKey: 'crsr_test',
  cwd: outDir,
});

describe('call_agent (real Cursor SDK, injected fake agent)', () => {
  it('streams events to onProgress and uses the agent-written findings file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deps = baseDeps(dir);
      const progress: string[] = [];
      const closed = vi.fn();
      const prompt = vi.fn();

      const events = [
        { type: 'status', status: 'RUNNING' },
        { type: 'thinking', text: 'reading files' },
        { type: 'tool_call', name: 'read', status: 'completed' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'found the cause' }] } },
      ];
      const run = fakeRun({ events, result: { status: 'finished', result: 'The bug is a race in foo.ts' } });

      const callAgent = createCallAgentCursor({
        ...deps,
        timeoutMs: 5000,
        onProgress: (l) => progress.push(l),
        agentFactory: writingFactory(dir, run, { closed, prompt }),
      });

      const rec = await callAgent({ task: 'why is the test flaky' });

      // Streamed lines reached onProgress (live terminal visibility).
      expect(progress.some((l) => l.includes('found the cause'))).toBe(true);
      expect(progress.some((l) => l.includes('read'))).toBe(true);
      expect(progress.some((l) => l.includes('RUNNING'))).toBe(true);

      // The deliverable points at the AGENT-WRITTEN file (real findings).
      expect(rec).not.toBeNull();
      expect(() => DeliverableRecord.parse(rec)).not.toThrow();
      expect(rec!.kind).toBe('markdown');
      expect(rec!.filePath).toBeTruthy();
      expect(readFileSync(rec!.filePath ?? '', 'utf-8')).toContain('Agent-written findings');
      // Description derives from the run summary.
      expect(rec!.description).toContain('race in foo.ts');
      // Appended to the deliverables log and the agent was closed.
      expect(deps.deliverables.snapshot().map((e) => e.data.id)).toContain(rec!.id);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finished but no findings file written → null, NO deliverable (no fallback)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deps = baseDeps(dir);
      const closed = vi.fn();
      // Run finishes but the agent never writes the file.
      const run = fakeRun({ result: { status: 'finished', result: 'Summary: the cache is stale.' } });
      const callAgent = createCallAgentCursor({
        ...deps,
        onProgress: () => {},
        agentFactory: nonWritingFactory(run, { closed, prompt: () => {} }),
      });

      const rec = await callAgent({ task: 'investigate stale cache' });

      expect(rec).toBeNull();
      expect(deps.deliverables.snapshot()).toHaveLength(0);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on timeout: cancels the run, returns null, registers NO deliverable (never throws)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deps = baseDeps(dir);
      const cancelled = vi.fn();
      const closed = vi.fn();
      const run = fakeRun({ hang: true, supportsCancel: true, onCancel: cancelled });
      const callAgent = createCallAgentCursor({
        ...deps,
        timeoutMs: 20, // tiny budget so the test is fast
        onProgress: () => {},
        agentFactory: nonWritingFactory(run, { closed, prompt: () => {} }),
      });

      const rec = await callAgent({ task: 'a task that hangs' });

      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(rec).toBeNull();
      expect(deps.deliverables.snapshot()).toHaveLength(0);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on agent failure: logs, returns null, registers NO deliverable (never throws out of dispatch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = baseDeps(dir);
      // The factory itself throws (e.g. bad credentials / network) — the worst case.
      const callAgent = createCallAgentCursor({
        ...deps,
        onProgress: () => {},
        agentFactory: async () => {
          throw new Error('auth failed');
        },
      });

      const rec = await callAgent({ task: 'anything' });

      expect(rec).toBeNull();
      expect(deps.deliverables.snapshot()).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Sub-agent status emission (#16/#18) — driven with the SAME injected fake agent (NO live Cursor run,
 * no credits). When a `subAgents` log is injected, the call emits status as APPENDS keyed by the run
 * id: a `running` record before the run, fresh `running` records as progress streams, then a terminal
 * `done` (real findings written) or `error` (timeout/failure/no-file). The deliverable id and the
 * terminal `deliverableId` must match. This is what lets the heartbeat observe the run live.
 */
describe('call_agent sub-agent status emission (running → done / error)', () => {
  const latest = (log: ReturnType<typeof createAppendLog<SubAgentTaskRecordT>>): SubAgentTaskRecordT[] =>
    foldLatestById(log.snapshot().map((e) => e.data));

  it('emits running (with progress) then done, with deliverableId matching the record id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deliverables = createAppendLog<DeliverableRecordT>();
      const subAgents = createAppendLog<SubAgentTaskRecordT>();
      const run = fakeRun({
        events: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'reading files' }] } }],
        result: { status: 'finished', result: 'all clear' },
      });
      const callAgent = createCallAgentCursor({
        deliverables,
        subAgents,
        outDir: dir,
        apiKey: 'crsr_test',
        cwd: dir,
        onProgress: () => {},
        // Success path: the agent writes the findings file.
        agentFactory: writingFactory(dir, run),
      });

      const rec = await callAgent({ task: 'check the build' });
      expect(rec).not.toBeNull();

      // The FIRST append is a running record (announced before agent.send).
      const all = subAgents.snapshot().map((e) => e.data);
      expect(all[0]!.status).toBe('running');
      // Progress streamed into the record (the streamed line is on the tail).
      expect(all.some((s) => s.progress.some((p) => p.includes('reading files')))).toBe(true);
      // The folded (latest) state is `done`, linked to the produced deliverable by id.
      const [current] = latest(subAgents);
      expect(current!.status).toBe('done');
      expect(current!.deliverableId).toBe(rec!.id);
      expect(current!.endedAt).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a terminal error status (and NO deliverable) on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deliverables = createAppendLog<DeliverableRecordT>();
      const subAgents = createAppendLog<SubAgentTaskRecordT>();
      const run = fakeRun({ hang: true, supportsCancel: true });
      const callAgent = createCallAgentCursor({
        deliverables,
        subAgents,
        outDir: dir,
        apiKey: 'crsr_test',
        cwd: dir,
        timeoutMs: 20,
        onProgress: () => {},
        agentFactory: nonWritingFactory(run, { closed: () => {}, prompt: () => {} }),
      });

      const rec = await callAgent({ task: 'a hang' });

      expect(rec).toBeNull();
      expect(deliverables.snapshot()).toHaveLength(0);
      const [current] = latest(subAgents);
      expect(current!.status).toBe('error');
      expect(current!.error).toContain('Timed out');
      expect(current!.endedAt).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a terminal error status (and NO deliverable) when the agent factory throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deliverables = createAppendLog<DeliverableRecordT>();
      const subAgents = createAppendLog<SubAgentTaskRecordT>();
      const callAgent = createCallAgentCursor({
        deliverables,
        subAgents,
        outDir: dir,
        apiKey: 'crsr_test',
        cwd: dir,
        onProgress: () => {},
        agentFactory: async () => {
          throw new Error('auth failed');
        },
      });

      const rec = await callAgent({ task: 'anything' });

      expect(rec).toBeNull();
      expect(deliverables.snapshot()).toHaveLength(0);
      const [current] = latest(subAgents);
      expect(current!.status).toBe('error');
      expect(current!.error).toContain('auth failed');
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works without a subAgents log (existing unit-test path): success → one deliverable, no crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deliverables = createAppendLog<DeliverableRecordT>();
      const run = fakeRun({ result: { status: 'finished', result: 'done' } });
      const callAgent = createCallAgentCursor({
        deliverables,
        outDir: dir,
        apiKey: 'crsr_test',
        cwd: dir,
        onProgress: () => {},
        agentFactory: writingFactory(dir, run),
      });

      const rec = await callAgent({ task: 'no status please' });
      expect(rec).not.toBeNull();
      expect(rec!.kind).toBe('markdown');
      expect(deliverables.snapshot()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
