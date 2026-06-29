import { useMemo } from 'react';
import { formatClock } from '../lib/format';
import { IconActivity } from '../lib/icons';
import { useStickToBottom } from '../lib/use-stick-to-bottom';
import { useHarnessStore } from '../store';

/**
 * One row in the brain's-eye timeline: either a conversation turn the brain heard, or a heartbeat
 * decision it made. `tie` keeps ordering stable when a turn and the decision that reacted to it
 * share a timestamp -- the turn (0) sorts before the decision (1).
 */
type Beat =
  | { kind: 'turn'; ts: number; tie: 0; key: string; who: string; dataKind: string; text: string }
  | { kind: 'decision'; ts: number; tie: 1; key: string; name: string; detail: string; isNoOp: boolean };

/**
 * The Brain tab -- the brain's-eye view. NOT just the brain's tool calls: the FULL conversation it
 * reasons over (human + agent turns) interleaved, in time order, with every heartbeat decision it
 * makes (incl. `no_op`, which dispatches nothing and is otherwise invisible). Decisions come from the
 * server's `decision` broadcast, not the transcript, so the model never sees its own decisions echoed
 * back. Turns read like the transcript; decision beats are accented inset rows (muted for `no_op`) so
 * you can read, beat by beat, what the brain heard and what it chose to do about it. Tool activity
 * lives in the Tools tab -- not duplicated here.
 */
export function DecisionFeed() {
  const transcript = useHarnessStore((state) => state.transcript);
  const decisions = useHarnessStore((state) => state.decisions);

  const beats = useMemo<Beat[]>(() => {
    const out: Beat[] = [];
    for (const entry of transcript) {
      if (entry.data.senderKind === 'tool') continue; // tool activity lives in the Tools tab
      const who =
        entry.data.senderKind === 'agent' ? 'Agent' : entry.data.participantId || 'Speaker';
      out.push({
        kind: 'turn',
        ts: entry.data.timestamp,
        tie: 0,
        key: `t-${entry.seqNo}`,
        who,
        dataKind: entry.data.senderKind,
        text: entry.data.text,
      });
    }
    decisions.forEach((d, i) => {
      out.push({
        kind: 'decision',
        ts: d.ts,
        tie: 1,
        key: `d-${d.ts}-${i}`,
        name: d.name,
        detail: d.detail,
        isNoOp: d.name === 'no_op',
      });
    });
    out.sort((a, b) => a.ts - b.ts || a.tie - b.tie);
    return out;
  }, [transcript, decisions]);

  const { ref, onScroll } = useStickToBottom(beats);

  if (beats.length === 0) {
    return (
      <div className="empty">
        <IconActivity size={24} className="glyph" />
        <span className="t">No brain activity yet</span>
        <span className="h">the full conversation + every heartbeat decision (incl. staying silent) shows here</span>
      </div>
    );
  }

  return (
    <div className="scroller" ref={ref} onScroll={onScroll} role="log" aria-label="Brain feed">
      <div className="feed">
        {beats.map((b) =>
          b.kind === 'turn' ? (
            <article key={b.key} className="turn" data-kind={b.dataKind}>
              <div className="gutter">
                <span className="who">{b.who}</span>
                <span className="ts tnum">{formatClock(b.ts)}</span>
              </div>
              <div className="body">{b.text}</div>
            </article>
          ) : (
            <article key={b.key} className="turn" data-kind="brain" data-noop={b.isNoOp}>
              <div className="gutter">
                <span className="who" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <IconActivity size={11} />
                  brain
                </span>
                <span className="ts tnum">{formatClock(b.ts)}</span>
              </div>
              <div className="body">
                <span className="decided">{b.name}</span>
                {b.detail ? <div className="detail">{b.detail}</div> : null}
              </div>
            </article>
          ),
        )}
      </div>
    </div>
  );
}
