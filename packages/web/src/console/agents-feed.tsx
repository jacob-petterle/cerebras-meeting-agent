import type { LogEntry, SubAgentTaskRecord } from '@meeting-agent/protocol';
import { useMemo } from 'react';
import { IconBot } from '../lib/icons';
import { useHarnessStore } from '../store';

/**
 * The research-assistant view. The subAgents resource is an append-log of status records (running →
 * progress → done/error, keyed by id), so — exactly like the server, the brain, and the Deliverables
 * list — we fold latest-per-id on read to get each task's CURRENT state. This is what makes the slow
 * Cursor research VISIBLE while it runs: the heartbeat no longer blocks on it, so the brain keeps
 * ticking and this list updates live as each progress line streams in (Task #18).
 *
 * Running tasks are shown first (most recent first) with their latest streamed progress line; finished
 * and errored tasks fall below. A done task links to its deliverable id so the operator can correlate
 * it with the Deliverables tab.
 */
function latestPerId(entries: LogEntry<SubAgentTaskRecord>[]): SubAgentTaskRecord[] {
  const byId = new Map<string, SubAgentTaskRecord>();
  for (const entry of entries) byId.set(entry.data.id, entry.data);
  return [...byId.values()];
}

/** Sort running first, then by most-recent start — the operator cares most about what's live now. */
function ordered(tasks: SubAgentTaskRecord[]): SubAgentTaskRecord[] {
  const rank = (t: SubAgentTaskRecord): number => (t.status === 'running' ? 0 : 1);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
}

const STATUS_COLOR: Record<SubAgentTaskRecord['status'], string> = {
  running: 'var(--accent)',
  done: 'var(--success)',
  error: 'var(--danger)',
};

export function AgentsFeed() {
  const entries = useHarnessStore((state) => state.subAgents);
  const tasks = useMemo(() => ordered(latestPerId(entries)), [entries]);

  if (tasks.length === 0) {
    return (
      <div className="empty">
        <IconBot size={24} className="glyph" />
        <span className="t">No research in flight</span>
        <span className="h">call_agent dispatches show here live while they run</span>
      </div>
    );
  }

  return (
    <div className="scroller" role="list" aria-label="Research sub-agents">
      <div className="feed">
        {tasks.map((t) => {
          const lastProgress = t.progress.at(-1) ?? '';
          const detail = t.status === 'error' && t.error ? t.error : lastProgress;
          return (
            <div
              key={t.id}
              className="tool"
              role="listitem"
              style={{ borderLeftColor: STATUS_COLOR[t.status] }}
            >
              <div className="head">
                <span className="name" style={{ color: STATUS_COLOR[t.status] }}>
                  {t.status}
                </span>
                <span className="ts tnum">{t.id.slice(0, 8)}</span>
              </div>
              <div className="detail">{t.task}</div>
              {detail ? (
                <div className="detail" style={{ color: 'var(--faint)' }}>
                  {detail}
                </div>
              ) : null}
              {t.deliverableId ? (
                <div className="detail" style={{ color: 'var(--faint)' }}>
                  deliverable {t.deliverableId.slice(0, 8)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
