import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type CallAgentArgs, DeliverableRecord } from '@meeting-agent/protocol';
import type { AppendLog } from '../../resources';

/**
 * call_agent (mock) — the return-contract stand-in for the real Cursor SDK sub-agent.
 *
 * Writes a fixed FINDINGS.md to `outDir`, registers a `DeliverableRecord` (kind 'markdown') on the
 * deliverables log, and returns that record — all in well under a second so the spine can be
 * exercised on a live turn. The real sub-agent (tools/callAgent/cursor.ts) honours the SAME contract:
 * (args) => Promise<DeliverableRecord>, appended to the same log.
 */

export interface CallAgentMockDeps {
  deliverables: AppendLog<DeliverableRecord>;
  /** Directory the FINDINGS.md is written into (caller owns its lifecycle). */
  outDir: string;
}

/**
 * `null` is the "no findings" result — the real Cursor sub-agent returns it on any failure (timeout,
 * error, no file written) rather than fabricating a fallback deliverable. The mock always succeeds.
 */
export type CallAgentFn = (args: CallAgentArgs) => Promise<DeliverableRecord | null>;

/**
 * The mock deliverable mirrors the SHAPE of a real findings doc: dense markdown written for the BRAIN
 * to READ (never displayed), the same contract the real Cursor sub-agent honours (callAgent/cursor.ts
 * buildPrompt). It is not a slide — there is no screenful budget — so the mock just echoes the task in a
 * small structured markdown block the deliverables resource can inline for the brain.
 */
function findingsMarkdown(task: string): string {
  return `# Findings

**Task:** ${task}

Mock sub-agent result — the real Cursor SDK agent populates this with grounded findings (file:line,
counts, code blocks, and mermaid diagrams where they aid understanding).
`;
}

export function createCallAgentMock(deps: CallAgentMockDeps): CallAgentFn {
  return async (args: CallAgentArgs): Promise<DeliverableRecord> => {
    const id = randomUUID();
    mkdirSync(deps.outDir, { recursive: true });
    const filePath = join(deps.outDir, `FINDINGS-${id}.md`);
    writeFileSync(filePath, findingsMarkdown(args.task), 'utf-8');

    const now = Date.now();
    const record = DeliverableRecord.parse({
      id,
      kind: 'markdown',
      title: 'Sub-agent findings',
      description: `Mock findings for task: ${args.task}`,
      filePath,
      mimeType: 'text/markdown',
      producedAt: now,
      registeredAt: now,
    });

    deps.deliverables.append(record);
    return record;
  };
}
