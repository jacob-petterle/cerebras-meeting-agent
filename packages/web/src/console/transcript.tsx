import { useMemo } from 'react';
import { formatClock } from '../lib/format';
import { IconTranscript } from '../lib/icons';
import { useStickToBottom } from '../lib/use-stick-to-bottom';
import { useHarnessStore } from '../store';
import { fetchOlder } from '../ws';

/**
 * Live transcript -- the append-log consumer's primary view. Shows the
 * conversation (human + agent turns); tool activity lives in the Tool feed. The
 * store hands us a whole array with a stable reference, so this only re-renders
 * when a turn is actually appended.
 */
export function Transcript() {
  const transcript = useHarnessStore((state) => state.transcript);
  const convo = useMemo(
    () => transcript.filter((entry) => entry.data.senderKind !== 'tool'),
    [transcript],
  );
  const { ref, onScroll } = useStickToBottom(convo);
  const lowestSeq = transcript[0]?.seqNo ?? -1;

  if (convo.length === 0) {
    return (
      <div className="empty">
        <IconTranscript size={24} className="glyph" />
        <span className="t">Waiting for the meeting to start</span>
        <span className="h">speak into the mic — turns appear here</span>
      </div>
    );
  }

  return (
    <div
      className="scroller"
      ref={ref}
      onScroll={onScroll}
      role="log"
      aria-label="Live transcript"
    >
      {lowestSeq > 0 ? (
        <div className="section-h">
          transcript
          <button
            type="button"
            className="link-btn more"
            onClick={() => fetchOlder('transcript', lowestSeq, 50)}
          >
            Load earlier
          </button>
        </div>
      ) : null}
      <div className="feed">
        {convo.map((entry) => {
          const who =
            entry.data.senderKind === 'agent'
              ? 'Agent'
              : entry.data.participantId || 'Speaker';
          return (
            <article key={entry.seqNo} className="turn" data-kind={entry.data.senderKind}>
              <div className="gutter">
                <span className="who">{who}</span>
                <span className="ts tnum">{formatClock(entry.data.timestamp)}</span>
              </div>
              <div className="body">{entry.data.text}</div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
