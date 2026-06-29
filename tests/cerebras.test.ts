import { describe, it, expect } from 'vitest';
import { assembleStream } from '../packages/server/src/core/cerebras';
import type { StreamChunk } from '../packages/server/src/core/cerebras';
import { decisionsFromResult } from '../packages/server/src/core/decide';

async function* feed(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c;
}

describe('cerebras assembleStream (tool_calls accumulated by index)', () => {
  it('assembles a complete tool_call from a chunked streamed fixture by index', async () => {
    // The Cerebras quirk: a single tool call is streamed across many chunks; only
    // `index` ties the argument fragments together. name+id arrive on the first delta,
    // arguments arrive as a string split across later deltas.
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { role: 'assistant' } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'call_agent' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"task":"res' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'earch X"}' } }] } }] },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
      },
    ];

    const result = await assembleStream(feed(chunks));

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      index: 0,
      id: 'call_1',
      name: 'call_agent',
      arguments: '{"task":"research X"}',
    });
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ task: 'research X' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 7, totalTokens: 17 });
  });

  it('assembles TWO interleaved/out-of-order tool calls, keyed by index', async () => {
    // Fragments for index 0 and index 1 are interleaved and arrive out of order.
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'speak' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'share_screen' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"kind":"html",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 1, function: { arguments: '"payload":"<b>x</b>"}' } }] } },
        ],
      },
    ];

    const result = await assembleStream(feed(chunks));

    // Output is ordered by index regardless of arrival order.
    expect(result.toolCalls.map((t) => t.name)).toEqual(['speak', 'share_screen']);
    expect(result.toolCalls.map((t) => t.index)).toEqual([0, 1]);
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ text: 'hi' });
    expect(JSON.parse(result.toolCalls[1]!.arguments)).toEqual({ kind: 'html', payload: '<b>x</b>' });
  });

  it('accumulates plain content when no tool call is emitted', async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const result = await assembleStream(feed(chunks));
    expect(result.content).toBe('Hello');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('an empty stream yields an empty result (no calls, no content, null usage/rate)', async () => {
    const result = await assembleStream(feed([]));
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe('');
    expect(result.finishReason).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.tokensPerSec).toBeNull();
  });

  it('a stream with no tool_calls → decisionsFromResult → [no_op]', async () => {
    const chunks: StreamChunk[] = [
      { choices: [{ delta: { content: 'just chatting' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const result = await assembleStream(feed(chunks));
    expect(decisionsFromResult(result)).toEqual([{ name: 'no_op', args: {} }]);
  });

  it('tokensPerSec is null (not 0) when completion_tokens is 0, even with elapsed time', async () => {
    // A delay before the usage chunk forces elapsedMs > 0, so the null result is attributable to
    // completion_tokens === 0 — NOT to a zero-elapsed fast path that would mask a `* 1000 == 0` bug.
    async function* slowFeed(): AsyncGenerator<StreamChunk> {
      yield { choices: [{ delta: { role: 'assistant' } }] };
      await new Promise((r) => setTimeout(r, 5));
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      };
    }
    const result = await assembleStream(slowFeed());
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 0, totalTokens: 5 });
    expect(result.tokensPerSec).toBeNull();
  });

  it('skips malformed tool_call indices (negative / non-integer) without corrupting the map', async () => {
    const chunks: StreamChunk[] = [
      // valid call at index 0
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'ok', function: { name: 'speak' } }] } }] },
      // malformed indices must be ignored, never bucketed
      { choices: [{ delta: { tool_calls: [{ index: -1, function: { name: 'speak' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1.5, function: { name: 'speak' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"hi"}' } }] } }] },
    ];
    const result = await assembleStream(feed(chunks));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ index: 0, name: 'speak', arguments: '{"text":"hi"}' });
  });
});
