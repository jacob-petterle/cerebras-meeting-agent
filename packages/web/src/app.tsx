import { useEffect, useState } from 'react';
import { Console } from './console/console';
import { IconActivity, IconMic, IconMicOff, IconOffline, IconReset } from './lib/icons';
import { formatUptime } from './lib/format';
import { startMic, stopMic } from './mic';
import { Stage } from './stage/stage';
import { useHarnessStore } from './store';
import { resolveWsUrl, sendReset } from './ws';

function ConnectionPill() {
  const connection = useHarnessStore((state) => state.connection);
  const connectedSince = useHarnessStore((state) => state.connectedSince);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (connection !== 'open') return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [connection]);

  const label = connection === 'open' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline';
  const uptime =
    connection === 'open' && connectedSince !== null ? formatUptime(Date.now() - connectedSince) : null;

  return (
    <span className="pill" data-state={connection} role="status">
      <span className="dot" />
      {label}
      {uptime ? <span className="tnum" style={{ color: 'var(--faint)' }}>· {uptime}</span> : null}
    </span>
  );
}

function MicMeter() {
  const level = useHarnessStore((state) => state.micLevel);
  return (
    <div className="mic-meter" aria-hidden="true">
      <i style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, level)).toFixed(3)})` }} />
    </div>
  );
}

function MicControl() {
  const micOn = useHarnessStore((state) => state.micOn);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setError(null);
    try {
      if (micOn) stopMic();
      else await startMic();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone unavailable');
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {micOn ? <MicMeter /> : null}
      <button
        type="button"
        className="mic-btn"
        data-on={micOn}
        aria-pressed={micOn}
        aria-label={micOn ? 'Stop microphone' : 'Start microphone'}
        onClick={() => void toggle()}
      >
        {micOn ? <IconMicOff className="mic-glyph" /> : <IconMic className="mic-glyph" />}
        <span>{micOn ? 'Stop' : 'Mic'}</span>
      </button>
      {error ? (
        <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ResetButton() {
  return (
    <button
      type="button"
      className="mic-btn"
      onClick={() => sendReset()}
      aria-label="Reset session"
      title="Clear the transcript, deliverables, decisions, and stage (keeps the models warm)"
    >
      <IconReset className="mic-glyph" />
      <span>Reset</span>
    </button>
  );
}

function OfflineBanner() {
  const connection = useHarnessStore((state) => state.connection);
  if (connection === 'open') return null;
  return (
    <div className="banner" role="status">
      <IconOffline size={15} />
      <span>
        {connection === 'connecting'
          ? 'Connecting to the agent server…'
          : 'Agent server offline — retrying.'}{' '}
        The console fills once it is reachable.
      </span>
      <code>{resolveWsUrl()}</code>
    </div>
  );
}

/**
 * Decide whether to render the deliverable-only stage (the DEFAULT — what a screenshare should show)
 * or the full operator console (header, mic, console tabs, HUD). Precedence:
 *   - `?view=stage`     → always stage-only (the Zoom bot loads this, so its share is clean regardless)
 *   - `?view=full` / `?debug` → always the full console (ad-hoc override)
 *   - otherwise         → follow the build-time debug flag VITE_DEBUG_UI, defaulting to stage-only.
 * So the full web app appears ONLY when launched with the debug flag (`VITE_DEBUG_UI=1`, e.g.
 * `pnpm web:debug`) or an explicit `?debug` URL; everything else is the deliverable alone.
 */
function resolveStageOnly(): boolean {
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view === 'stage') return true;
  if (view === 'full') return false;
  const debugParam = params.has('debug') && !['0', 'false'].includes(params.get('debug') ?? '');
  if (debugParam) return false;
  const env = import.meta.env.VITE_DEBUG_UI;
  const debugEnv = env === '1' || env === 'true';
  return !debugEnv;
}

export function App() {
  // Default render is the screenshare surface (no chrome): just the agent-state aurora when nothing is
  // shared, the deliverable + an aurora PIP when it is. The full operator console is debug-gated — see
  // resolveStageOnly. `?view=stage` is kept as an explicit force for the Zoom bot.
  if (resolveStageOnly()) {
    return (
      <div className="stage-only">
        <Stage minimal />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <IconActivity size={18} style={{ color: 'var(--accent)' }} />
          <h1>Meeting Agent</h1>
          <span className="sub">local harness</span>
        </div>
        <ConnectionPill />
        <MicControl />
        <ResetButton />
      </header>
      <OfflineBanner />
      <main className="main">
        <Console />
        <Stage />
      </main>
    </div>
  );
}
