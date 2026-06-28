/**
 * Local "speakers": Web Audio playback for the TTS frames the server pushes as
 * `{ type: 'play', sampleRate, pcm }`. pcm is Int16 sample values (number[]) per
 * the protocol. Frames are scheduled back-to-back so consecutive sentences play
 * gaplessly. The AudioContext can only start after a user gesture, so it is
 * unlocked when the user starts the mic (see mic.ts) -- frames arriving before
 * that are scheduled best-effort.
 */

let ctx: AudioContext | null = null;
let nextStartTime = 0;

function context(): AudioContext {
  /**
   * Recreate when missing OR when a prior context was closed (a backgrounded /
   * long-idle tab can close it). A closed context can't createBuffer, so without
   * this the audio silently drops. The cursor resets with the fresh context.
   */
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext();
    nextStartTime = 0;
  }
  return ctx;
}

/** Resume the playback context inside a user gesture so later frames are audible. */
export function unlockPlayback(): void {
  const audio = context();
  if (audio.state === 'suspended') {
    void audio.resume();
  }
}

/** Schedule one TTS frame. Int16 -> Float32, queued after the previously-scheduled tail. */
export function playPcm(sampleRate: number, pcm: number[]): void {
  if (pcm.length === 0 || sampleRate <= 0) return;
  const audio = context();
  if (audio.state === 'suspended') {
    void audio.resume();
  }

  const buffer = audio.createBuffer(1, pcm.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) {
    channel[i] = (pcm[i] ?? 0) / 32768;
  }

  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);

  /**
   * Clamp the cursor forward so a gap (a backgrounded tab, a long idle between
   * frames) can't schedule in the past -- start() with a past time would play
   * immediately and the back-to-back gapless invariant would collapse.
   */
  nextStartTime = Math.max(nextStartTime, audio.currentTime + 0.02);
  source.start(nextStartTime);
  nextStartTime += buffer.duration;
}
