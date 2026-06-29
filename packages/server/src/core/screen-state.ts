import type { RenderCommand } from '@meeting-agent/protocol';

/**
 * screen-state.ts — the shared screen as observable session state.
 *
 * Today the brain has NO idea what's on the shared screen or for how long, so it can't reason about
 * "should I keep this diagram up or take it down?". This tracks the CURRENT active share so each beat
 * can render a `<screen>` resource (what's shown + its age) inside the `<meeting>` envelope.
 *
 * Crucially it models the screen HONESTLY, because a real meeting (Zoom et al.) can have MULTIPLE
 * shares — another participant can take over the screen at any time. So the state carries `mine`:
 *   - mine=true  → WE put it up via share_screen; the brain can trust its diagram is visible.
 *   - mine=false → someone else is presenting; the brain must NOT assume its artifact is on screen.
 *
 * For the local harness and the demo bot (the only sharer), every share is ours, so `mine` is true and
 * the state is exactly accurate today. {@link ScreenState.noteExternalShare} is the SEAM for wiring the
 * bot's Zoom `onSharingStatus` back-channel later (MeetingShareCtrlEvent already RECEIVES those events;
 * they're just not forwarded to the server yet) — drop-in, no redesign.
 */

/** The artifact currently on the shared screen. */
export interface ActiveShare {
  /** Human label for what's shown — the artifact's title, else its kind. */
  label: string;
  /** Render kind ('html' | 'mermaid' | …) when ours; '' for an external presenter. */
  kind: string;
  /** epoch-ms when this share became the active one (for age rendering). */
  since: number;
  /** True when WE rendered it (share_screen); false when another participant is presenting. */
  mine: boolean;
}

export interface ScreenState {
  /** Record that WE rendered an artifact to the shared screen (the `share_screen` tool fired). */
  noteOurShare(cmd: RenderCommand, now: number): void;
  /**
   * Record an EXTERNAL share-state change from the meeting transport — the future seam for the Zoom
   * back-channel. `active:true` with a presenter ⇒ someone else took the screen; `active:false` ⇒
   * sharing stopped (screen cleared). Unused today (no back-channel); present so wiring it is a drop-in.
   */
  noteExternalShare(input: { active: boolean; presenter: string | null; now: number }): void;
  /** Clear on session reset — nothing is on screen. */
  clear(): void;
  /** The current active share, or null when the screen is empty. */
  current(): ActiveShare | null;
}

/** A short, safe label for one of our renders: prefer the title, fall back to the kind. */
function labelFor(cmd: RenderCommand): string {
  const title = cmd.title?.trim();
  return title && title.length > 0 ? title : cmd.kind;
}

export function createScreenState(): ScreenState {
  let active: ActiveShare | null = null;

  return {
    noteOurShare(cmd, now) {
      active = { label: labelFor(cmd), kind: cmd.kind, since: now, mine: true };
    },

    noteExternalShare({ active: isActive, presenter, now }) {
      if (!isActive) {
        active = null;
        return;
      }
      const who = presenter?.trim();
      active = {
        label: who && who.length > 0 ? `${who} is sharing` : 'someone is sharing',
        kind: '',
        since: now,
        mine: false,
      };
    },

    clear() {
      active = null;
    },

    current() {
      return active;
    },
  };
}
