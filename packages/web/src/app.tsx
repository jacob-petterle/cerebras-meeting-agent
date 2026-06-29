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

export function App() {
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
