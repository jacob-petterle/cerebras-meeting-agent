import { formatClock } from '../lib/format';
import { IconActivity } from '../lib/icons';
import { useStickToBottom } from '../lib/use-stick-to-bottom';
import { useHarnessStore } from '../store';

/**
 * The brain's decision feed -- EVERY heartbeat decision, including `no_op` (which dispatches nothing
 * and is otherwise invisible). These come from the server's `decision` broadcast, NOT the transcript,
 * so the model never sees its own decisions echoed back. `no_op` is muted so the acting turns stand
 * out, but it's still shown -- proof the brain is ticking and choosing silence on purpose.
 */
export function DecisionFeed() {
  const decisions = useHarnessStore((state) => state.decisions);
  const { ref, onScroll } = useStickToBottom(decisions);

  if (decisions.length === 0) {
    return (
      <div className="empty">
        <IconActivity size={24} className="glyph" />
        <span className="t">No decisions yet</span>
        <span className="h">every 5s heartbeat -- including staying silent -- shows here</span>
      </div>
    );
  }

  return (
    <div className="scroller" ref={ref} onScroll={onScroll} role="log" aria-label="Decision feed">
      <div className="feed">
        {decisions.map((d, i) => {
          const isNoOp = d.name === 'no_op';
          return (
            <div
              key={`${d.ts}-${i}`}
              className="tool"
              style={isNoOp ? { opacity: 0.55 } : undefined}
            >
              <div className="head">
                <span
                  className="name"
                  style={{ color: isNoOp ? 'var(--faint)' : 'var(--accent)' }}
                >
                  {d.name}
                </span>
                <span className="ts tnum">{formatClock(d.ts)}</span>
              </div>
              {d.detail ? <div className="detail">{d.detail}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
