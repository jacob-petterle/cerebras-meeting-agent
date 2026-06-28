import type { LogEntry, SenderKind, TranscriptEntry } from '@meeting-agent/protocol';
import { describe, expect, it } from 'vitest';
import { deriveMetrics } from './metrics';

/**
 * deriveMetrics is the HUD's domain logic, extracted from the component so it can
 * be tested without React. Covers: response latency from a human→agent gap,
 * tok/s (server figure preferred over the transcript estimate), turn/tool counts,
 * and empty-input safety.
 */

let seq = 0;
const turn = (
  senderKind: SenderKind,
  timestamp: number,
  text = '',
): LogEntry<TranscriptEntry> => ({
  seqNo: seq++,
  ts: timestamp,
  data: { participantId: senderKind === 'human' ? 'u1' : 'agent', senderKind, text, timestamp },
});

describe('deriveMetrics', () => {
  it('is safe on empty input', () => {
    const m = deriveMetrics([], null);
    expect(m).toEqual({
      tokPerSec: null,
      tokEstimated: false,
      lastLatency: null,
      avgLatency: null,
      turns: 0,
      tools: 0,
      promptTokens: null,
      completionTokens: null,
    });
  });

  it('derives response latency from a human→agent gap', () => {
    const m = deriveMetrics(
      [turn('human', 1000), turn('agent', 1340, 'four chars here')],
      null,
    );
    expect(m.lastLatency).toBe(340);
    expect(m.avgLatency).toBe(340);
  });

  it('averages only the last five latencies', () => {
    const t: LogEntry<TranscriptEntry>[] = [];
    // six human→agent pairs with gaps 100..600
    for (let i = 1; i <= 6; i++) {
      t.push(turn('human', i * 1000));
      t.push(turn('agent', i * 1000 + i * 100, 'x'));
    }
    const m = deriveMetrics(t, null);
    expect(m.lastLatency).toBe(600);
    // last five gaps are 200,300,400,500,600 -> mean 400
    expect(m.avgLatency).toBe(400);
  });

  it('estimates tok/s from the agent reply over the latency when no server stats', () => {
    // 8-char reply -> ceil(8/4)=2 est tokens; gap 1000ms -> 2 tok/s.
    const m = deriveMetrics([turn('human', 0), turn('agent', 1000, '12345678')], null);
    expect(m.tokEstimated).toBe(true);
    expect(m.tokPerSec).toBeCloseTo(2, 5);
  });

  it('prefers the server tokensPerSec over the estimate', () => {
    const m = deriveMetrics([turn('human', 0), turn('agent', 1000, '12345678')], {
      tokensPerSec: 950,
      promptTokens: 1200,
      completionTokens: 64,
    });
    expect(m.tokEstimated).toBe(false);
    expect(m.tokPerSec).toBe(950);
    expect(m.promptTokens).toBe(1200);
    expect(m.completionTokens).toBe(64);
  });

  it('falls back to the estimate when server tokensPerSec is null', () => {
    const m = deriveMetrics([turn('human', 0), turn('agent', 1000, '12345678')], {
      tokensPerSec: null,
      promptTokens: 1200,
      completionTokens: 0,
    });
    expect(m.tokEstimated).toBe(true);
    expect(m.tokPerSec).toBeCloseTo(2, 5);
    // token counts still surface from the frame.
    expect(m.promptTokens).toBe(1200);
  });

  it('counts turns and tools, excluding tools from turns', () => {
    const m = deriveMetrics(
      [turn('human', 0), turn('tool', 10), turn('agent', 100, 'x'), turn('tool', 200)],
      null,
    );
    expect(m.turns).toBe(2);
    expect(m.tools).toBe(2);
  });

  it('ignores a negative gap (agent timestamp before the human turn)', () => {
    const m = deriveMetrics([turn('human', 1000), turn('agent', 500, 'x')], null);
    expect(m.lastLatency).toBeNull();
    expect(m.avgLatency).toBeNull();
  });
});
