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
/**
 * A tap on the TTS playback graph: every frame is also routed here, giving a live MediaStream of the
 * agent's voice. The agent-state visualizer wraps this stream and reads its volume so the orb pulses
 * while the agent speaks. It carries the same audio as the speakers (silent when nothing is playing).
 */
let streamTap: MediaStreamAudioDestinationNode | null = null;

function context(): AudioContext {
  /**
   * Recreate when missing OR when a prior context was closed (a backgrounded /
   * long-idle tab can close it). A closed context can't createBuffer, so without
   * this the audio silently drops. The cursor resets with the fresh context.
   */
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext();
    nextStartTime = 0;
    streamTap = ctx.createMediaStreamDestination();
  }
  return ctx;
}

/**
 * The agent's-voice MediaStream (the playback tap). Ensures the context exists so the stream is
 * available even before the first frame plays (it's just silent until then). Null only if Web Audio
 * is unavailable. Used by the agent-state visualizer for the speaking volume nudge.
 */
export function getPlaybackStream(): MediaStream | null {
  context();
  return streamTap ? streamTap.stream : null;
}

/**
 * Is the agent actually speaking RIGHT NOW? True while the scheduled TTS queue hasn't finished
 * draining (`nextStartTime` is still ahead of the context clock). This tracks ACTUAL audible playback,
 * not frame arrival — frames land in a burst but play out over seconds, so the visualizer must follow
 * the queue, not the arrivals, or its speaking state runs seconds ahead of the sound.
 */
export function isPlaying(): boolean {
  return !!ctx && ctx.state === 'running' && nextStartTime > ctx.currentTime + 0.02;
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
  /** Also feed the visualizer tap so the orb reacts to the agent's voice (same audio, for analysis). */
  if (streamTap) source.connect(streamTap);

  /**
   * Clamp the cursor forward so a gap (a backgrounded tab, a long idle between
   * frames) can't schedule in the past -- start() with a past time would play
   * immediately and the back-to-back gapless invariant would collapse.
   */
  nextStartTime = Math.max(nextStartTime, audio.currentTime + 0.02);
  source.start(nextStartTime);
  nextStartTime += buffer.duration;
}
