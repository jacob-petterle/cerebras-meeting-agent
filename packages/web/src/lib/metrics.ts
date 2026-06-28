import type { LogEntry, TranscriptEntry } from '@meeting-agent/protocol';
import type { ServerStats } from '../validate';
import { estimateTokens } from './format';

/**
 * Pure derivation of the tok/s + latency HUD model from the observed transcript
 * (and the optional server stats frame). Extracted from the presentational Hud
 * so it can be unit-tested without React.
 *
 * The locked protocol carries no inference metrics, so latency and tok/s are
 * DERIVED from the transcript: response latency = the gap from a human turn to
 * the next agent turn; tok/s = the agent reply's token estimate over that gap.
 * When the server emits a `{ type: 'stats' }` frame with a non-null tokensPerSec,
 * the readout switches to that reported figure (tokEstimated = false).
 */

export interface HudMetrics {
  /** tok/s: server-reported when available, else the transcript estimate. */
  tokPerSec: number | null;
  /** True when tokPerSec is the transcript proxy rather than a server figure. */
  tokEstimated: boolean;
  /** Most recent human→agent response gap, ms. */
  lastLatency: number | null;
  /** Mean of the last 5 response gaps, ms. */
  avgLatency: number | null;
  /** Total human + agent turns (tool entries excluded). */
  turns: number;
  /** Total tool entries. */
  tools: number;
  /** Server-reported prompt tokens for the last completion, if any. */
  promptTokens: number | null;
  /** Server-reported completion tokens for the last completion, if any. */
  completionTokens: number | null;
}

/** Compute the HUD model. Safe on empty input -- every field degrades to null/0. */
export function deriveMetrics(
  transcript: LogEntry<TranscriptEntry>[],
  stats: ServerStats | null,
): HudMetrics {
  let lastHumanTs: number | null = null;
  let lastAgentText = '';
  let turns = 0;
  let tools = 0;
  const latencies: number[] = [];

  for (const entry of transcript) {
    const kind = entry.data.senderKind;
    if (kind === 'tool') {
      tools += 1;
      continue;
    }
    turns += 1;
    if (kind === 'human') {
      lastHumanTs = entry.data.timestamp;
    } else {
      lastAgentText = entry.data.text;
      if (lastHumanTs !== null) {
        const gap = entry.data.timestamp - lastHumanTs;
        if (gap >= 0) latencies.push(gap);
      }
    }
  }

  const lastLatency = latencies.at(-1) ?? null;
  const recent = latencies.slice(-5);
  const avgLatency = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : null;

  let tokPerSec: number | null = null;
  let tokEstimated = false;
  if (stats && stats.tokensPerSec !== null) {
    tokPerSec = stats.tokensPerSec;
  } else if (lastLatency !== null && lastLatency > 0 && lastAgentText.length > 0) {
    tokPerSec = estimateTokens(lastAgentText) / (lastLatency / 1000);
    tokEstimated = true;
  }

  return {
    tokPerSec,
    tokEstimated,
    lastLatency,
    avgLatency,
    turns,
    tools,
    promptTokens: stats ? stats.promptTokens : null,
    completionTokens: stats ? stats.completionTokens : null,
  };
}
