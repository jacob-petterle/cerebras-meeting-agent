import { useMemo } from 'react';
import { formatDuration } from '../lib/format';
import { deriveMetrics } from '../lib/metrics';
import { useHarnessStore } from '../store';

/**
 * tok/s + latency HUD. The domain derivation lives in lib/metrics.ts (pure +
 * unit-tested); this component just selects state and renders the model.
 *
 * The locked protocol carries no inference metrics, so latency/tok/s are DERIVED
 * from the observed transcript and marked "est" because they're proxies. Once the
 * server emits a `{ type:'stats' }` frame with a real tokensPerSec, the tok/s
 * value switches to the reported figure and the sub-label shows the real
 * completion-token count instead of "est".
 */

function Metric({
  label,
  value,
  sub,
  accent,
  estimated,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  estimated?: boolean;
}) {
  return (
    <div className={`metric${accent ? ' accent' : ''}${estimated ? ' est' : ''}`}>
      <span className="label">{label}</span>
      <span className="value tnum">
        {value}
        {sub ? <small> {sub}</small> : null}
      </span>
    </div>
  );
}

export function Hud() {
  const transcript = useHarnessStore((state) => state.transcript);
  const deliverables = useHarnessStore((state) => state.deliverables);
  const renderCount = useHarnessStore((state) => state.renderCount);
  const stats = useHarnessStore((state) => state.stats);

  const d = useMemo(() => deriveMetrics(transcript, stats), [transcript, stats]);
  const artifactCount = useMemo(
    () => new Set(deliverables.map((entry) => entry.data.id)).size,
    [deliverables],
  );

  const tok = d.tokPerSec === null ? '—' : d.tokPerSec.toFixed(d.tokPerSec >= 10 ? 0 : 1);
  const tokSub =
    d.tokPerSec === null
      ? ''
      : d.tokEstimated
        ? 'est'
        : d.completionTokens !== null
          ? `${d.completionTokens} tok`
          : 'server';

  return (
    <div className="hud" aria-label="Performance">
      <div className="hud-grid">
        <Metric
          label="tok/s"
          value={tok}
          accent
          estimated={d.tokPerSec !== null && d.tokEstimated}
          sub={tokSub}
        />
        <Metric
          label="response"
          value={d.lastLatency === null ? '—' : formatDuration(d.lastLatency)}
          sub={d.avgLatency === null ? undefined : `avg ${formatDuration(d.avgLatency)}`}
        />
        <Metric label="turns" value={String(d.turns)} sub={`${d.tools} tools`} />
        <Metric label="artifacts" value={String(artifactCount)} sub={`${renderCount} shared`} />
      </div>
    </div>
  );
}
