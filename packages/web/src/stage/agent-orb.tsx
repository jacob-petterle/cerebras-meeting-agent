import { useEffect, useMemo, useState } from 'react';
import { LocalAudioTrack } from 'livekit-client';
import type { AgentState } from '@livekit/components-react';
import { AgentAudioVisualizerAura } from '../agents-ui/agent-audio-visualizer-aura';
import { getPlaybackStream, isPlaying } from '../playback';
import { useHarnessStore } from '../store';

/**
 * The agent's-presence orb — a LiveKit "Aura" shader driven by OUR live state. This is what fills the
 * screenshare when nothing is shared (and shrinks to PIP when a deliverable is up), so the room always
 * has a real-time cue of what the agent is doing.
 *
 * The phase is DERIVED from the signals already on the wire — researching folds into `thinking`:
 *   speaking (recent TTS frames) > thinking (brain mid-decide) | researching (sub-agent running) >
 *   listening (mic on) > idle.
 * The agent's TTS audio is wrapped into a LocalAudioTrack so the orb pulses with its voice while speaking.
 */

const LABELS: Record<AgentState, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  connecting: 'Connecting',
  initializing: 'Starting',
  disconnected: 'Offline',
  failed: 'Error',
  'pre-connect-buffering': 'Listening',
};

function useAgentPhase(): AgentState {
  const thinking = useHarnessStore((s) => s.thinking);
  const micOn = useHarnessStore((s) => s.micOn);
  const subAgents = useHarnessStore((s) => s.subAgents);

  // `isPlaying()` is module state (the playback queue), so re-evaluate on a ticker to catch its edges.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 120);
    return () => window.clearInterval(id);
  }, []);

  const researching = useMemo(() => {
    const latest = new Map<string, string>();
    for (const e of subAgents) latest.set(e.data.id, e.data.status);
    for (const status of latest.values()) if (status === 'running') return true;
    return false;
  }, [subAgents]);

  // Speaking tracks the ACTUAL audible queue, not frame arrival — so the orb stays in sync with sound.
  if (isPlaying()) return 'speaking';
  if (thinking || researching) return 'thinking';
  if (micOn) return 'listening';
  return 'idle';
}

/** Wrap the TTS-playback MediaStream into a LiveKit LocalAudioTrack so the orb reacts to the agent's voice. */
function usePlaybackTrack(): LocalAudioTrack | undefined {
  const [track, setTrack] = useState<LocalAudioTrack>();
  useEffect(() => {
    const mst = getPlaybackStream()?.getAudioTracks()[0];
    if (!mst) return;
    // userProvidedTrack=true → the SDK never tries to (re)acquire or manage it via a Room.
    setTrack(new LocalAudioTrack(mst, undefined, true));
    // No cleanup stop(): the underlying MediaStreamTrack belongs to the persistent playback graph.
  }, []);
  return track;
}

export function AgentOrb({ pip = false }: { pip?: boolean }) {
  const state = useAgentPhase();
  const audioTrack = usePlaybackTrack();
  return (
    <div className={pip ? 'agent-orb pip' : 'agent-orb'} data-state={state} role="status" aria-label={`Agent: ${LABELS[state]}`}>
      <div className="aura-box">
        <AgentAudioVisualizerAura
          state={state}
          audioTrack={audioTrack}
          color="#2fd4bd"
          colorShift={0.08}
          themeMode="dark"
        />
      </div>
      <div className="agent-orb-label tnum">{LABELS[state]}</div>
    </div>
  );
}
