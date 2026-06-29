import { type ComponentType, type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { SVGProps } from 'react';
import { IconActivity, IconBot, IconFile, IconTool, IconTranscript } from '../lib/icons';
import { useHarnessStore } from '../store';
import { AgentsFeed } from './agents-feed';
import { DecisionFeed } from './decision-feed';
import { Deliverables } from './deliverables';
import { Hud } from './hud';
import { ToolFeed } from './tool-feed';
import { Transcript } from './transcript';

type TabKey = 'transcript' | 'brain' | 'tools' | 'agents' | 'deliverables';
type IconCmp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const ORDER: TabKey[] = ['transcript', 'brain', 'tools', 'agents', 'deliverables'];
const TABS: { key: TabKey; label: string; Icon: IconCmp }[] = [
  { key: 'transcript', label: 'Transcript', Icon: IconTranscript },
  { key: 'brain', label: 'Brain', Icon: IconActivity },
  { key: 'tools', label: 'Tools', Icon: IconTool },
  { key: 'agents', label: 'Agents', Icon: IconBot },
  { key: 'deliverables', label: 'Deliverables', Icon: IconFile },
];

/**
 * Observability console: the HUD plus a tabbed view over the three subscribe-driven
 * feeds. Tabs follow the ARIA tabs pattern -- roving tabindex, Arrow/Home/End move
 * between tabs, the active tab is the only one in the tab order.
 */
export function Console() {
  const [active, setActive] = useState<TabKey>('brain');
  const transcript = useHarnessStore((state) => state.transcript);
  const deliverables = useHarnessStore((state) => state.deliverables);
  const subAgents = useHarnessStore((state) => state.subAgents);
  const decisions = useHarnessStore((state) => state.decisions);
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});

  const counts = useMemo(() => {
    let tools = 0;
    let convo = 0;
    for (const entry of transcript) {
      if (entry.data.senderKind === 'tool') tools += 1;
      else convo += 1;
    }
    const ids = new Set(deliverables.map((entry) => entry.data.id));
    /** Agents count = how many sub-agents are CURRENTLY running (folded latest-per-id) — the live signal. */
    const latestStatus = new Map<string, string>();
    for (const entry of subAgents) latestStatus.set(entry.data.id, entry.data.status);
    let running = 0;
    for (const status of latestStatus.values()) if (status === 'running') running += 1;
    return { transcript: convo, brain: decisions.length, tools, agents: running, deliverables: ids.size };
  }, [transcript, deliverables, subAgents, decisions]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const idx = ORDER.indexOf(active);
    let nextIdx = idx;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIdx = (idx + 1) % ORDER.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      nextIdx = (idx - 1 + ORDER.length) % ORDER.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = ORDER.length - 1;
    else return;
    event.preventDefault();
    const nextKey = ORDER[nextIdx];
    if (!nextKey) return;
    setActive(nextKey);
    tabRefs.current[nextKey]?.focus();
  };

  return (
    <section className="console-pane" aria-label="Observability console">
      <Hud />
      <div className="tabs">
        <div className="tablist" role="tablist" aria-label="Console views">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`tab-${key}`}
              className="tab"
              aria-selected={active === key}
              aria-controls={`panel-${key}`}
              tabIndex={active === key ? 0 : -1}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              onClick={() => setActive(key)}
              onKeyDown={onKeyDown}
            >
              <Icon size={14} />
              {label}
              <span className="count tnum">{counts[key]}</span>
            </button>
          ))}
        </div>
        <div
          className="tabpanel"
          role="tabpanel"
          id={`panel-${active}`}
          aria-labelledby={`tab-${active}`}
          tabIndex={0}
        >
          {active === 'transcript' ? <Transcript /> : null}
          {active === 'brain' ? <DecisionFeed /> : null}
          {active === 'tools' ? <ToolFeed /> : null}
          {active === 'agents' ? <AgentsFeed /> : null}
          {active === 'deliverables' ? <Deliverables /> : null}
        </div>
      </div>
    </section>
  );
}
