import { z } from 'zod';
import type { LogEntry, TranscriptEntry } from '@meeting-agent/protocol';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AppendLog } from './resources';
import type { CerebrasClient } from './cerebras';

/**
 * Transcript corrector — a SECOND, dedicated Gemma call whose only job is to clean up raw STT output
 * using the prior conversation as context. It is walled off from the brain (decide.ts): different
 * system prompt, different message list, no tools. It runs as step ONE of each heartbeat, BEFORE
 * decide reads the transcript. That ordering is the gate: raw STT text never enters the transcript —
 * only corrected text is appended — so the brain only ever observes corrected words.
 *
 * Cache-friendly by construction (Cerebras prompt caching is automatic, matches in 128-token blocks,
 * and requires an EXACT prefix match):
 *   [static system][frozen corrected history …]   ← stable, append-only prefix → warm cache
 *   [the new raw batch + instruction]             ← volatile tail (the only part that changes)
 * The history grows but never mutates (it's an append-log), so every beat after the first reuses the
 * cached prefix and only the new tail is processed. NOTE: on Cerebras the cache is a time-to-first-
 * token win, not a billing discount — cached and fresh input tokens cost the same.
 */

/** One raw STT segment awaiting correction (buffered between heartbeats). */
export interface RawUtterance {
  participantId: string;
  text: string;
  timestamp: number;
}

export interface Corrector {
  /**
   * Correct a batch of raw STT segments using the prior conversation as context. Returns the
   * corrected text in the SAME order and count as the input. NEVER throws and never blocks past the
   * timeout: on any failure (network, timeout, malformed model output, length mismatch) it returns
   * the raw text unchanged — the safe fallback for the gate (better a slightly-off line than a lost
   * or blocked turn).
   */
  correct(batch: RawUtterance[]): Promise<string[]>;
}

/**
 * Marathon-session safety cap on how many prior turns we feed as context. Below this the prefix is
 * append-only and the cache stays warm; past it the window slides each beat and busts the cache — a
 * deliberate trade of cache-warmth for a bounded prompt only on very long sessions.
 */
const MAX_CONTEXT_TURNS = 200;
const DEFAULT_TIMEOUT_MS = 2000;

const CORRECTION_SYSTEM = `You correct raw speech-to-text from a live meeting. Each segment may contain recognition errors: misheard words, wrong homophones, and mangled proper nouns or technical terms. Use the prior conversation as context to fix them.

Rules:
- Fix only clear recognition errors. Use the conversation context to restore names, products, and jargon (e.g. a term that was spelled correctly earlier in the conversation).
- Do NOT rephrase, summarize, translate, answer, or add or remove content. Preserve the speaker's exact wording and meaning.
- Fix capitalization of proper nouns and obvious punctuation only.
- If a segment already looks correct, return it unchanged.
- Output ONLY a JSON array of strings: the corrected text of each segment, in the same order and the same count as the input. No prose, no markdown, no code fences.`;

/** Render the corrected history as a stable, deterministic context block (the cacheable prefix). */
function renderHistory(entries: LogEntry<TranscriptEntry>[]): string {
  const capped = entries.slice(-MAX_CONTEXT_TURNS);
  if (capped.length === 0) return '(no prior conversation yet)';
  return capped
    .map((e) => {
      const who = e.data.senderKind === 'human' ? e.data.participantId : e.data.senderKind;
      return `${who}: ${e.data.text}`;
    })
    .join('\n');
}

function buildMessages(history: string, batch: RawUtterance[]): ChatCompletionMessageParam[] {
  const numbered = batch.map((u, i) => `${i + 1}. ${u.text}`).join('\n');
  // History FIRST (stable, cacheable prefix); the volatile batch LAST.
  const user =
    `Conversation so far (already corrected — context only, do not re-output):\n${history}\n\n` +
    `Correct these ${batch.length} new raw segment(s). Return a JSON array of exactly ${batch.length} string(s), same order:\n${numbered}`;
  return [
    { role: 'system', content: CORRECTION_SYSTEM },
    { role: 'user', content: user },
  ];
}

const StringArray = z.array(z.string());

/** Extract a JSON string array from the model's content, tolerating code fences / stray prose. */
function parseCorrections(content: string, expected: number): string[] | null {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = StringArray.safeParse(parsed);
  /** A length mismatch means the model lost the 1:1 mapping — fall back to raw rather than misalign. */
  if (!result.success || result.data.length !== expected) return null;
  return result.data;
}

export interface CorrectorDeps {
  cerebras: CerebrasClient;
  /** The corrected-transcript log — read as frozen context (its snapshot is the cacheable prefix). */
  transcript: AppendLog<TranscriptEntry>;
  /** Hard cap on a single correction call; on timeout we fall back to raw. Default 2s. */
  timeoutMs?: number;
}

export function createCorrector(deps: CorrectorDeps): Corrector {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async correct(batch) {
      if (batch.length === 0) return [];
      const raw = batch.map((u) => u.text);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const messages = buildMessages(renderHistory(deps.transcript.snapshot()), batch);
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('correction timeout')), timeoutMs);
          /** Don't let a pending correction timer keep the process alive on its own. */
          if (typeof timer.unref === 'function') timer.unref();
        });
        const result = await Promise.race([deps.cerebras.complete({ messages }), timeout]);
        return parseCorrections(result.content, batch.length) ?? raw;
      } catch (err) {
        console.error('[correct] failed, using raw transcription:', err);
        return raw;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
