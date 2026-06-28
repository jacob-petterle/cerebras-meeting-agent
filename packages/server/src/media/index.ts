/**
 * Media leg public surface. Consumers (orchestrator wiring, adapters) import from here and depend
 * only on the interfaces + factories — never on a concrete model. On-device only — no hosted
 * providers, no fallbacks.
 */

export type {
  Vad,
  Stt,
  Tts,
  Utterance,
  SttConfig,
  TtsConfig,
  VadConfig,
} from './interface';
export { TARGET_SAMPLE_RATE } from './interface';
export { createVad } from './vad';
export { createStt } from './stt';
export { createTts } from './tts';
export {
  int16ToFloat32,
  float32ToInt16,
  resampleFloat32,
  resampleInt16,
} from './pcm';
