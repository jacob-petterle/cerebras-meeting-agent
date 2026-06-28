import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type CallAgentArgs, DeliverableRecord } from '@meeting-agent/protocol';
import type { AppendLog } from '../../resources';

/**
 * call_agent (mock) — the return-contract stand-in for the real Cursor SDK sub-agent.
 *
 * Writes a fixed FINDINGS.html to `outDir`, registers a `DeliverableRecord` (kind 'html') on the
 * deliverables log, and returns that record — all in well under a second so the spine can be
 * exercised on a live turn. The real sub-agent (tools/callAgent/cursor.ts, step 8) honours the
 * SAME contract: (args) => Promise<DeliverableRecord>, appended to the same log.
 */

export interface CallAgentMockDeps {
  deliverables: AppendLog<DeliverableRecord>;
  /** Directory the FINDINGS.html is written into (caller owns its lifecycle). */
  outDir: string;
}

export type CallAgentFn = (args: CallAgentArgs) => Promise<DeliverableRecord>;

function findingsHtml(task: string): string {
  const safe = task.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Findings</title></head>
  <body>
    <h1>Findings</h1>
    <p><strong>Task:</strong> ${safe}</p>
    <p>This is a mock sub-agent result. The real Cursor SDK agent will populate this page.</p>
  </body>
</html>
`;
}

export function createCallAgentMock(deps: CallAgentMockDeps): CallAgentFn {
  return async (args: CallAgentArgs): Promise<DeliverableRecord> => {
    const id = randomUUID();
    mkdirSync(deps.outDir, { recursive: true });
    const filePath = join(deps.outDir, `FINDINGS-${id}.html`);
    writeFileSync(filePath, findingsHtml(args.task), 'utf-8');

    const now = Date.now();
    const record = DeliverableRecord.parse({
      id,
      kind: 'html',
      title: 'Sub-agent findings',
      description: `Mock findings for task: ${args.task}`,
      filePath,
      mimeType: 'text/html',
      producedAt: now,
      registeredAt: now,
    });

    deps.deliverables.append(record);
    return record;
  };
}
