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
 * touches the network or spends Cursor credits. The fake mirrors the slice of `@cursor/sdk` cursor.ts
 * drives: an agent that returns a `Run` whose `stream()` yields `SDKMessage`-shaped events and whose
 * `wait()` resolves a `RunResult`. We assert the four behaviors the contract guarantees: streams to
 * onProgress, uses the agent-written file when present, falls back to a synthesized file when absent,
 * and turns timeout/error into a renderable fallback deliverable (never a throw).
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

/** A fake agent factory whose `send` returns the supplied run; records prompt + close for assertions. */
function fakeFactory(run: CursorRun, spies: { closed: () => void; prompt: (p: string) => void }) {
  const agent: CursorAgent = {
    send: async (prompt: string) => {
      spies.prompt(prompt);
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

      // The fake agent "writes" the exact findings file the prompt asked for, mid-run.
      const events = [
        { type: 'status', status: 'RUNNING' },
        { type: 'thinking', text: 'reading files' },
        { type: 'tool_call', name: 'read', status: 'completed' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'found the cause' }] } },
      ];
      // Capture the path from the prompt and write to it, simulating the agent's file write.
      const run = fakeRun({ events, result: { status: 'finished', result: 'The bug is a race in foo.ts' } });
      const factory = async () => ({
        send: async (p: string) => {
          prompt(p);
          const match = p.match(/FINDINGS-[0-9a-f-]+\.html/);
          if (match) writeFileSync(join(dir, match[0]), '<h1>Agent-written findings</h1>', 'utf-8');
          return run;
        },
        close: () => closed(),
      });

      const callAgent = createCallAgentCursor({
        ...deps,
        timeoutMs: 5000,
        onProgress: (l) => progress.push(l),
        agentFactory: factory,
      });

      const rec = await callAgent({ task: 'why is the test flaky' });

      // Streamed lines reached onProgress (live terminal visibility).
      expect(progress.some((l) => l.includes('found the cause'))).toBe(true);
      expect(progress.some((l) => l.includes('read'))).toBe(true);
      expect(progress.some((l) => l.includes('RUNNING'))).toBe(true);

      // The deliverable points at the AGENT-WRITTEN file (real findings, not a fallback).
      expect(() => DeliverableRecord.parse(rec)).not.toThrow();
      expect(rec.kind).toBe('html');
      expect(rec.filePath).toBeTruthy();
      expect(readFileSync(rec.filePath ?? '', 'utf-8')).toContain('Agent-written findings');
      // Description derives from the run summary.
      expect(rec.description).toContain('race in foo.ts');
      // Appended to the deliverables log and the agent was closed.
      expect(deps.deliverables.snapshot().map((e) => e.data.id)).toContain(rec.id);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('synthesizes a fallback HTML file from the run summary when the agent did not write one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deps = baseDeps(dir);
      const closed = vi.fn();
      // Run finishes but never writes the file.
      const run = fakeRun({ result: { status: 'finished', result: 'Summary: the cache is stale.' } });
      const callAgent = createCallAgentCursor({
        ...deps,
        agentFactory: fakeFactory(run, { closed, prompt: () => {} }),
      });

      const rec = await callAgent({ task: 'investigate stale cache' });

      expect(rec.kind).toBe('html');
      expect(rec.filePath).toBeTruthy();
      const html = readFileSync(rec.filePath ?? '', 'utf-8');
      // The fallback page is built from the summary text and is valid standalone HTML.
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('the cache is stale');
      expect(html).toContain('did not write a findings file');
      expect(deps.deliverables.snapshot()).toHaveLength(1);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on timeout: cancels the run and still produces a fallback deliverable (never throws)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    try {
      const deps = baseDeps(dir);
      const cancelled = vi.fn();
      const closed = vi.fn();
      // The run hangs (wait never resolves) → the wall-clock timeout fires.
      const run = fakeRun({ hang: true, supportsCancel: true, onCancel: cancelled });
      const callAgent = createCallAgentCursor({
        ...deps,
        timeoutMs: 20, // tiny budget so the test is fast
        onProgress: () => {},
        agentFactory: fakeFactory(run, { closed, prompt: () => {} }),
      });

      const rec = await callAgent({ task: 'a task that hangs' });

      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(rec.kind).toBe('html');
      expect(rec.filePath).toBeTruthy();
      const html = readFileSync(rec.filePath ?? '', 'utf-8');
      expect(html).toContain('timed out');
      expect(rec.description).toContain('timed out');
      expect(deps.deliverables.snapshot()).toHaveLength(1);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on agent failure: logs and returns a fallback deliverable, never throwing out of dispatch', async () => {
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

      expect(() => DeliverableRecord.parse(rec)).not.toThrow();
      expect(rec.kind).toBe('html');
      expect(rec.description).toContain('failed');
      const html = readFileSync(rec.filePath ?? '', 'utf-8');
      expect(html).toContain('auth failed');
      expect(deps.deliverables.snapshot()).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Sub-agent status emission (#16/#18) — driven with the SAME injected fake agent (NO live Cursor run,
 * no credits). When a `subAgents` log is injected, the call must emit status as APPENDS keyed by the
 * run id: a `running` record before the run, fresh `running` records as progress streams, then a
 * terminal `done` (success) or `error` (timeout/failure). The deliverable id and the terminal
 * `deliverableId` must match (same minted id). This is what lets the heartbeat observe the run live.
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
        agentFactory: fakeFactory(run, { closed: () => {}, prompt: () => {} }),
      });

      const rec = await callAgent({ task: 'check the build' });

      // The FIRST append is a running record (announced before agent.send).
      const all = subAgents.snapshot().map((e) => e.data);
      expect(all[0]!.status).toBe('running');
      // Progress streamed into the record (the streamed line is on the tail).
      expect(all.some((s) => s.progress.some((p) => p.includes('reading files')))).toBe(true);
      // The folded (latest) state is `done`, linked to the produced deliverable by id.
      const [current] = latest(subAgents);
      expect(current!.status).toBe('done');
      expect(current!.deliverableId).toBe(rec.id);
      expect(current!.endedAt).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a terminal error status on timeout (the run hangs)', async () => {
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
        agentFactory: fakeFactory(run, { closed: () => {}, prompt: () => {} }),
      });

      await callAgent({ task: 'a hang' });

      const [current] = latest(subAgents);
      expect(current!.status).toBe('error');
      expect(current!.error).toContain('Timed out');
      expect(current!.endedAt).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a terminal error status when the agent factory throws', async () => {
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

      await callAgent({ task: 'anything' });

      const [current] = latest(subAgents);
      expect(current!.status).toBe('error');
      expect(current!.error).toContain('auth failed');
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works without a subAgents log (existing unit-test path): no status, deliverable unchanged', async () => {
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
        agentFactory: fakeFactory(run, { closed: () => {}, prompt: () => {} }),
      });

      const rec = await callAgent({ task: 'no status please' });
      expect(rec.kind).toBe('html');
      expect(deliverables.snapshot()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
