import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliverableRecord } from '@meeting-agent/protocol';
import type {
  CallAgentArgs,
  DeliverableRecord as DeliverableRecordT,
  RenderCommand,
  ToolCall,
} from '@meeting-agent/protocol';
import type { Ports } from '../packages/server/src/core/ports';
import { createRegistry } from '../packages/server/src/core/tools/registry';
import type { TtsResult } from '../packages/server/src/core/tools/registry';
import { createCallAgentMock } from '../packages/server/src/core/tools/callAgent/mock';
import { createAppendLog } from '../packages/server/src/core/resources';

function fakePorts() {
  const played: Array<{ pcm: Int16Array; sampleRate: number }> = [];
  const rendered: RenderCommand[] = [];
  const ports: Ports = {
    audioIn: { onPcm: () => () => {} },
    audioOut: {
      play: async (pcm, sampleRate) => {
        played.push({ pcm, sampleRate });
      },
    },
    display: {
      render: async (cmd) => {
        rendered.push(cmd);
      },
    },
  };
  return { ports, played, rendered };
}

const aDeliverable = (): DeliverableRecordT =>
  DeliverableRecord.parse({ id: 'x', kind: 'html', title: 't', producedAt: 1, registeredAt: 2 });

describe('tool registry routing (decide → act)', () => {
  it('routes speak → TTS → AudioOut', async () => {
    const { ports, played, rendered } = fakePorts();
    const tts = vi.fn(
      async (_text: string): Promise<TtsResult> => ({
        pcm: Int16Array.from([1, 2, 3]),
        sampleRate: 24000,
      }),
    );
    const callAgent = vi.fn(async (_a: CallAgentArgs) => aDeliverable());
    const reg = createRegistry({ ports, tts, callAgent });

    const call: ToolCall = { name: 'speak', args: { text: 'hello there' } };
    const outcome = await reg.dispatch(call);

    expect(tts).toHaveBeenCalledWith('hello there');
    expect(played).toHaveLength(1);
    expect(Array.from(played[0]!.pcm)).toEqual([1, 2, 3]);
    expect(played[0]!.sampleRate).toBe(24000);
    expect(rendered).toHaveLength(0);
    // speak → an `agent` turn carrying the spoken text (for transcript write-back).
    expect(outcome).toEqual({ senderKind: 'agent', text: 'hello there' });
  });

  it('routes share_screen → Display', async () => {
    const { ports, played, rendered } = fakePorts();
    const tts = vi.fn(
      async (_text: string): Promise<TtsResult> => ({ pcm: new Int16Array(), sampleRate: 24000 }),
    );
    const callAgent = vi.fn(async (_a: CallAgentArgs) => aDeliverable());
    const reg = createRegistry({ ports, tts, callAgent });

    const call: ToolCall = {
      name: 'share_screen',
      args: { kind: 'html', payload: '<h1>hi</h1>', title: 'Demo' },
    };
    const outcome = await reg.dispatch(call);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ kind: 'html', payload: '<h1>hi</h1>', title: 'Demo' });
    expect(played).toHaveLength(0);
    expect(tts).not.toHaveBeenCalled();
    // share_screen → a `tool` turn naming what was shared.
    expect(outcome).toEqual({ senderKind: 'tool', text: 'shared a html: Demo' });
  });

  it('renders share_screen without an optional title (label falls back to the kind)', async () => {
    const { ports, rendered } = fakePorts();
    const tts = vi.fn(
      async (_text: string): Promise<TtsResult> => ({ pcm: new Int16Array(), sampleRate: 24000 }),
    );
    const callAgent = vi.fn(async (_a: CallAgentArgs) => aDeliverable());
    const reg = createRegistry({ ports, tts, callAgent });

    const outcome = await reg.dispatch({
      name: 'share_screen',
      args: { kind: 'json', payload: '{"x":1}' },
    });

    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ kind: 'json', payload: '{"x":1}' });
    // No title → the tool turn falls back to the kind for its label.
    expect(outcome).toEqual({ senderKind: 'tool', text: 'shared a json: json' });
  });

  it('routes call_agent → appends a Deliverable to the deliverables log', async () => {
    const { ports } = fakePorts();
    const dir = mkdtempSync(join(tmpdir(), 'deliv-'));
    try {
      const deliverables = createAppendLog<DeliverableRecordT>();
      const callAgent = createCallAgentMock({ deliverables, outDir: dir });
      const tts = vi.fn(
        async (_text: string): Promise<TtsResult> => ({ pcm: new Int16Array(), sampleRate: 24000 }),
      );
      const reg = createRegistry({ ports, tts, callAgent });

      const outcome = await reg.dispatch({ name: 'call_agent', args: { task: 'research the thing' } });

      expect(deliverables.snapshot()).toHaveLength(1);
      expect(deliverables.snapshot()[0]!.data.kind).toBe('markdown');
      // call_agent → a `tool` turn naming the task + the deliverable id it produced.
      const deliverableId = deliverables.snapshot()[0]!.data.id;
      expect(outcome).toEqual({
        senderKind: 'tool',
        text: `researched: research the thing (deliverable ${deliverableId})`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no_op routes to nothing and returns null (no transcript write-back)', async () => {
    const { ports, played, rendered } = fakePorts();
    const tts = vi.fn(
      async (_text: string): Promise<TtsResult> => ({ pcm: new Int16Array(), sampleRate: 24000 }),
    );
    const callAgent = vi.fn(async (_a: CallAgentArgs) => aDeliverable());
    const reg = createRegistry({ ports, tts, callAgent });

    const outcome = await reg.dispatch({ name: 'no_op', args: {} });

    expect(played).toHaveLength(0);
    expect(rendered).toHaveLength(0);
    expect(callAgent).not.toHaveBeenCalled();
    // no_op produces no turn → null, so main.ts appends nothing.
    expect(outcome).toBeNull();
  });

  it('rejects malformed args at the boundary via TOOL_ARGS (Zod)', async () => {
    const { ports } = fakePorts();
    const tts = vi.fn(
      async (_text: string): Promise<TtsResult> => ({ pcm: new Int16Array(), sampleRate: 24000 }),
    );
    const callAgent = vi.fn(async (_a: CallAgentArgs) => aDeliverable());
    const reg = createRegistry({ ports, tts, callAgent });

    // speak requires { text: string } — an empty object must be rejected, not silently played.
    await expect(reg.dispatch({ name: 'speak', args: {} })).rejects.toThrow();
    expect(tts).not.toHaveBeenCalled();
  });
});

describe('call_agent mock', () => {
  it('returns a DeliverableRecord whose filePath exists and matches the schema, in <1s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deliv-'));
    try {
      const deliverables = createAppendLog<DeliverableRecordT>();
      const mock = createCallAgentMock({ deliverables, outDir: dir });

      const t0 = Date.now();
      const rec = await mock({ task: 'investigate the flaky test' });
      const elapsed = Date.now() - t0;

      // the mock always produces a real deliverable (never the null "no findings" path)
      expect(rec).not.toBeNull();
      // matches the shared schema
      expect(() => DeliverableRecord.parse(rec)).not.toThrow();
      expect(rec!.kind).toBe('markdown');

      // filePath is real and on disk
      expect(rec!.filePath).toBeTruthy();
      expect(existsSync(rec!.filePath ?? '')).toBe(true);

      // surfaced on the deliverables log
      expect(deliverables.snapshot().map((e) => e.data.id)).toContain(rec!.id);

      // fast enough for a live turn
      expect(elapsed).toBeLessThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
