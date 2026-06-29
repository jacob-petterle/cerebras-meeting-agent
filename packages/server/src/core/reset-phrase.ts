/**
 * reset-phrase.ts — deterministic voice-command reset detector.
 *
 * Recognizes a spoken "start a fresh session" phrase from raw STT text so the operator can clear the
 * live meeting context MID-MEETING with one spoken line ("Atlas, let's start fresh") instead of
 * clicking the web console — the demo-friendly trigger. This is deliberately NOT a brain (Gemma) tool:
 * a destructive session wipe must fire reliably on the exact intent every demo take, not hinge on the
 * model choosing to call a tool. The matched utterance IS the command, so the caller drops it rather
 * than appending it to the (now empty) transcript.
 *
 * Matching is conservative — it requires an explicit reset intent, not just the word "start" — so an
 * ordinary sentence mid-conversation can't trip a wipe. Casing and surrounding punctuation are ignored
 * (raw Moonshine STT carries neither reliably); inner whitespace is collapsed before matching.
 */

/** Explicit reset intents. Each must encode a clear "wipe and begin again", never an incidental word. */
const RESET_PHRASES: RegExp[] = [
  /\b(let'?s |let us |can we |please )?start(ing)? (over|fresh|a new session|a fresh session|from scratch)\b/,
  /\b(clear|reset|wipe) (the |this |our )?(context|transcript|session|conversation|meeting|everything|history)\b/,
  /\bnew session\b/,
  /\bfresh start\b/,
];

/**
 * True when the (raw STT) utterance is a session-reset command. Pure and side-effect-free so the
 * wiring stays trivial to test: normalize (lowercase + collapse whitespace), then match any intent.
 */
export function isResetCommand(text: string): boolean {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm.length === 0) return false;
  return RESET_PHRASES.some((re) => re.test(norm));
}
