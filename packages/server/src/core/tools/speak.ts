import type { AudioOutPort } from '../ports';
import type { SpeakArgs } from '@meeting-agent/protocol';

/** TTS output handed to the AudioOut port. */
export interface TtsResult {
  pcm: Int16Array;
  sampleRate: number;
}

/** Injected TTS function (kokoro-js in prod; a stub in tests). */
export type TtsFn = (text: string) => Promise<TtsResult>;

/** speak: synthesize the text, then play it out the AudioOut port. */
export async function runSpeak(args: SpeakArgs, deps: { tts: TtsFn; audioOut: AudioOutPort }): Promise<void> {
  const { pcm, sampleRate } = await deps.tts(args.text);
  await deps.audioOut.play(pcm, sampleRate);
}
