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

// ---------------------------------------------------------------------------
// Software-GL detection + CSS fallback orb
// The WebGL fragment shader (react-shader-toy) pegs CPU when rendered by
// SwiftShader (Chrome --disable-gpu) or llvmpipe.  Detect once at mount and
// swap to the zero-GPU CSS orb so the bot container stays cool.
// ---------------------------------------------------------------------------

const ORB_COLORS: Record<AgentState, string> = {
  speaking:               '#2fd4bd',
  thinking:               '#f59e0b',
  listening:              '#6ee7d4',
  idle:                   '#1a6b5f',
  connecting:             '#1a6b5f',
  initializing:           '#1a6b5f',
  disconnected:           '#555',
  failed:                 '#ef4444',
  'pre-connect-buffering':'#1a6b5f',
};

const ORB_ANIM: Record<AgentState, string> = {
  speaking:               'cssorb-pulse 0.5s ease-in-out infinite',
  thinking:               'cssorb-pulse 0.9s ease-in-out infinite',
  listening:              'cssorb-breathe 1.5s ease-in-out infinite',
  idle:                   'cssorb-breathe 3s ease-in-out infinite',
  connecting:             'cssorb-breathe 2s ease-in-out infinite',
  initializing:           'cssorb-breathe 2s ease-in-out infinite',
  disconnected:           'none',
  failed:                 'none',
  'pre-connect-buffering':'cssorb-breathe 2s ease-in-out infinite',
};

let cssOrbStyleInjected = false;

/** Detect software WebGL renderer (SwiftShader / llvmpipe) at mount time. */
function useIsSwiftShader(): boolean {
  const [isSw, setIsSw] = useState(false);
  useEffect(() => {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
      if (!gl) { setIsSw(true); return; }
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return; // can't detect → assume hardware GL is fine
      const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
      if (/swiftshader|llvmpipe|software|mesa/i.test(renderer)) setIsSw(true);
    } catch { setIsSw(true); }
  }, []);
  return isSw;
}

/** Zero-CPU CSS orb — used when WebGL is running in software mode. */
function CssOrb({ state }: { state: AgentState }) {
  useEffect(() => {
    if (cssOrbStyleInjected) return;
    cssOrbStyleInjected = true;
    const el = document.createElement('style');
    el.textContent =
      '@keyframes cssorb-breathe{0%,100%{transform:scale(1);opacity:.4}50%{transform:scale(1.08);opacity:.72}}' +
      '@keyframes cssorb-pulse{0%,100%{transform:scale(1);opacity:.65}50%{transform:scale(1.18);opacity:1}}';
    document.head.appendChild(el);
  }, []);
  const color = ORB_COLORS[state];
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        width: '55%',
        aspectRatio: '1',
        borderRadius: '50%',
        background: `radial-gradient(circle at 38% 32%, ${color}cc 0%, ${color}55 55%, ${color}11 100%)`,
        boxShadow: `0 0 48px 12px ${color}44`,
        animation: ORB_ANIM[state],
      }} />
    </div>
  );
}

export function AgentOrb({ pip = false }: { pip?: boolean }) {
  const state = useAgentPhase();
  const audioTrack = usePlaybackTrack();
  const isSw = useIsSwiftShader();
  return (
    <div className={pip ? 'agent-orb pip' : 'agent-orb'} data-state={state} role="status" aria-label={`Agent: ${LABELS[state]}`}>
      <div className="aura-box">
        {isSw ? (
          <CssOrb state={state} />
        ) : (
          <AgentAudioVisualizerAura
            state={state}
            audioTrack={audioTrack}
            color="#2fd4bd"
            colorShift={0.08}
            themeMode="dark"
          />
        )}
      </div>
      <div className="agent-orb-label tnum">{LABELS[state]}</div>
    </div>
  );
}
