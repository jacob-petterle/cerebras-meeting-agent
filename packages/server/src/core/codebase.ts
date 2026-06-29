import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * codebase.ts — the repo the agent is EMBEDDED in, as an observable fact for the brain.
 *
 * The agent dispatches research sub-agents (call_agent) that run inside a real working tree — but its
 * prompt never tells it that. So it has no concept that "there's a codebase here I can investigate."
 * This captures the attached repo's identity (name + one-line description + the root its agents run in)
 * and renders it as a <codebase> resource, so when the room references the code, the brain knows it can
 * actually dig into it rather than guess.
 */

/** The codebase the research agents run against (their cwd / what ripgrep searches). */
export interface CodebaseInfo {
  /** Project name — package.json "name", else the directory name. */
  name: string;
  /** Absolute root the research agents investigate. */
  root: string;
  /** One-line description from package.json, when present (else ''). */
  description: string;
}

/** Escape attribute content so a name/description can't break out of the XML envelope. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Read the attached repo's identity at the given root. Best-effort: a missing/unreadable/!malformed
 * package.json falls back to the directory name and an empty description — never throws.
 */
export function describeCodebase(root: string): CodebaseInfo {
  let name = basename(root.replace(/[/\\]+$/, '')) || root;
  let description = '';
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      name?: unknown;
      description?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim()) name = pkg.name.trim();
    if (typeof pkg.description === 'string') description = pkg.description.trim();
  } catch {
    /* no readable package.json — the directory name stands in */
  }
  return { name, root, description };
}

/**
 * Render the <codebase> resource — a fixed, self-describing block telling the brain it's embedded in a
 * live repo its research agents can read and investigate. Static per session, but emitted as a resource
 * for consistency with the rest of the observed state.
 */
export function renderCodebaseResource(info: CodebaseInfo): string {
  const desc = info.description ? ` description="${xmlEscape(info.description)}"` : '';
  return (
    `<codebase name="${xmlEscape(info.name)}"${desc} ` +
    `note="you are embedded in this live codebase — your research agents (call_agent) can read, search, and investigate its real files. ` +
    `When the room references the code or asks how something works here, you can dig into it for real rather than guess." />`
  );
}
