import type { DeliverableRecord, LogEntry } from '@meeting-agent/protocol';
import { useMemo } from 'react';
import { IconFile } from '../lib/icons';
import { useHarnessStore } from '../store';

/**
 * Deliverables list. The deliverables resource is an append-log of upserts, so the
 * list shows the last record per id (last-writer-per-id on read -- per the Resource
 * model). The record currently on the stage (matched by deliverableId on the live
 * render) is highlighted.
 */
function lastPerId(entries: LogEntry<DeliverableRecord>[]): DeliverableRecord[] {
  const byId = new Map<string, DeliverableRecord>();
  for (const entry of entries) byId.set(entry.data.id, entry.data);
  return [...byId.values()];
}

export function Deliverables() {
  const entries = useHarnessStore((state) => state.deliverables);
  const onStageId = useHarnessStore((state) => state.render?.deliverableId ?? null);
  const items = useMemo(() => lastPerId(entries), [entries]);

  if (items.length === 0) {
    return (
      <div className="empty">
        <IconFile size={24} className="glyph" />
        <span className="t">No deliverables yet</span>
        <span className="h">call_agent results register here</span>
      </div>
    );
  }

  return (
    <div className="scroller" role="list" aria-label="Deliverables">
      {items.map((item) => {
        const onStage = item.id === onStageId;
        return (
          <div key={item.id} className="deliv" role="listitem" data-onstage={onStage}>
            <span className="kind" data-k={item.kind}>
              {item.kind}
            </span>
            <div className="meta">
              <span className="title">{item.title}</span>
              {item.description ? <span className="desc">{item.description}</span> : null}
              {item.filePath ? <span className="path">{item.filePath}</span> : null}
            </div>
            {onStage ? <span className="badge">on stage</span> : null}
          </div>
        );
      })}
    </div>
  );
}
