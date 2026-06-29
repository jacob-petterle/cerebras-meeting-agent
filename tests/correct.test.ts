import { describe, it, expect, vi } from 'vitest';
import type { TranscriptEntry } from '@meeting-agent/protocol';
import { createCorrector, type RawUtterance } from '../packages/server/src/core/correct';
import { createAppendLog } from '../packages/server/src/core/resources';
import type { AssembledResult, CerebrasClient } from '../packages/server/src/core/cerebras';

/** A minimal AssembledResult carrying only the `content` the corrector parses. */
function fakeResult(content: string): AssembledResult {
  return { toolCalls: [], content, finishReason: 'stop', usage: null, tokensPerSec: null, elapsedMs: 1 };
}

type CompleteArgs = { messages: { role: string; content: string }[] };

/** A fake Cerebras client whose `complete` returns the given content (and records its call args). */
function fakeCerebras(content: string) {
  const complete = vi.fn(async (_args: CompleteArgs): Promise<AssembledResult> => fakeResult(content));
  return { client: { complete } as unknown as CerebrasClient, complete };
}

const raw = (text: string): RawUtterance => ({ participantId: 'me', text, timestamp: 1 });

describe('transcript corrector', () => {
  it('maps a JSON array response to corrected text in order', async () => {
    const { client } = fakeCerebras('["Cerebras is fast", "use Gemma"]');
    const corrector = createCorrector({ cerebras: client, transcript: createAppendLog<TranscriptEntry>() });
    const out = await corrector.correct([raw('cerebrum is fast'), raw('use gemini')]);
    expect(out).toEqual(['Cerebras is fast', 'use Gemma']);
  });

  it('tolerates code fences / stray prose around the JSON array', async () => {
    const { client } = fakeCerebras('Sure:\n```json\n["Cerebras"]\n```');
    const corrector = createCorrector({ cerebras: client, transcript: createAppendLog<TranscriptEntry>() });
    expect(await corrector.correct([raw('cerebrum')])).toEqual(['Cerebras']);
  });

  it('returns [] for an empty batch without calling the model', async () => {
    const { client, complete } = fakeCerebras('[]');
    const corrector = createCorrector({ cerebras: client, transcript: createAppendLog<TranscriptEntry>() });
    expect(await corrector.correct([])).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to RAW when the model returns non-JSON', async () => {
    const { client } = fakeCerebras('here is the text: cerebrum is fast');
    const corrector = createCorrector({ cerebras: client, transcript: createAppendLog<TranscriptEntry>() });
    expect(await corrector.correct([raw('cerebrum is fast')])).toEqual(['cerebrum is fast']);
  });

  it('falls back to RAW on a length mismatch (lost 1:1 mapping)', async () => {
    const { client } = fakeCerebras('["only one"]');
    const corrector = createCorrector({ cerebras: client, transcript: createAppendLog<TranscriptEntry>() });
    expect(await corrector.correct([raw('one'), raw('two')])).toEqual(['one', 'two']);
  });

  it('falls back to RAW (and does not throw) when the model call rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const complete = vi.fn(async () => {
        throw new Error('network down');
      });
      const client = { complete } as unknown as CerebrasClient;
      const corrector = createCorrector({ cerebras: client, transcript: createAppendLog<TranscriptEntry>() });
      expect(await corrector.correct([raw('hello')])).toEqual(['hello']);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('falls back to RAW on timeout', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const complete = vi.fn(() => new Promise<never>(() => {})); // never resolves
      const client = { complete } as unknown as CerebrasClient;
      const corrector = createCorrector({
        cerebras: client,
        transcript: createAppendLog<TranscriptEntry>(),
        timeoutMs: 20,
      });
      expect(await corrector.correct([raw('hello')])).toEqual(['hello']);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('feeds prior conversation as context BEFORE the batch (cache-friendly ordering)', async () => {
    const { client, complete } = fakeCerebras('["Cerebras"]');
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append({ participantId: 'me', senderKind: 'human', text: 'Cerebras is fast', timestamp: 1 });
    const corrector = createCorrector({ cerebras: client, transcript });
    await corrector.correct([raw('cerebrum')]);

    const messages = complete.mock.calls[0]![0].messages;
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    const user = messages[1]!.content;
    // The prior (corrected) conversation appears as context, and BEFORE the raw segment to fix.
    expect(user).toContain('Cerebras is fast');
    expect(user.indexOf('Cerebras is fast')).toBeLessThan(user.indexOf('cerebrum'));
  });
});
