import { useMemo } from 'react';
import { formatClock } from '../lib/format';
import { IconTool } from '../lib/icons';
import { useStickToBottom } from '../lib/use-stick-to-bottom';
import { useHarnessStore } from '../store';

/**
 * Tool-call feed -- the `senderKind: 'tool'` slice of the same transcript log. This
 * is where speak / share_screen / call_agent / no_op activity surfaces as the agent
 * acts. participantId carries the tool name; text carries the detail.
 */
export function ToolFeed() {
  const transcript = useHarnessStore((state) => state.transcript);
  const tools = useMemo(
    () => transcript.filter((entry) => entry.data.senderKind === 'tool'),
    [transcript],
  );
  const { ref, onScroll } = useStickToBottom(tools);

  if (tools.length === 0) {
    return (
      <div className="empty">
        <IconTool size={24} className="glyph" />
        <span className="t">No tool calls yet</span>
        <span className="h">the agent's actions stream here</span>
      </div>
    );
  }

  return (
    <div className="scroller" ref={ref} onScroll={onScroll} role="log" aria-label="Tool-call feed">
      <div className="feed">
        {tools.map((entry) => (
          <div key={entry.seqNo} className="tool">
            <div className="head">
              <span className="name">{entry.data.participantId || 'tool'}</span>
              <span className="ts tnum">{formatClock(entry.data.timestamp)}</span>
            </div>
            <div className="detail">{entry.data.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
