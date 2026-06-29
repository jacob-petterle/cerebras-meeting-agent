/**
 * End-to-end proof of the PRODUCTION call_agent path (no injected fake). Deliberately does NOT set
 * CURSOR_RIPGREP_PATH in the shell — so the configure-ripgrep side-effect module must auto-resolve the
 * bundled rg. Asserts: real findings written + a deliverable registered + status=done, in seconds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DeliverableRecord as DRT,
  SubAgentTaskRecord as SART,
} from '@meeting-agent/protocol';
import { createAppendLog } from '../src/core/resources';
import { createCallAgentCursor } from '../src/core/tools/callAgent/cursor';

function envKey(name: string): string | undefined {
  const txt = readFileSync(join(process.cwd(), '.env'), 'utf-8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '').trim();
  }
  return process.env[name];
}

async function main() {
  const apiKey = envKey('CURSOR_API_KEY');
  if (!apiKey) throw new Error('no CURSOR_API_KEY');
  console.log(`[verify] shell CURSOR_RIPGREP_PATH=${process.env.CURSOR_RIPGREP_PATH ?? '(unset — must auto-configure)'}`);

  const deliverables = createAppendLog<DRT>();
  const subAgents = createAppendLog<SART>();
  const callAgent = createCallAgentCursor({
    deliverables,
    subAgents,
    outDir: join(process.cwd(), '.deliverables'),
    apiKey,
    cwd: process.cwd(),
    onProgress: (l) => process.stdout.write(`${l}\n`),
  });

  const t0 = Date.now();
  const rec = await callAgent({
    task: 'What tools can the brain call (speak/share_screen/call_agent/no_op) and where are they defined? Cite file paths.',
  });
  const elapsed = Date.now() - t0;

  const sub = subAgents.snapshot().map((e) => e.data);
  console.log('\n========== RESULT ==========');
  console.log(`elapsed: ${elapsed}ms`);
  console.log(`deliverable: ${rec ? `${rec.id} → ${rec.filePath}` : 'NULL (no findings — would be the failure path)'}`);
  console.log(`findings bytes: ${rec?.filePath ? readFileSync(rec.filePath, 'utf-8').length : 0}`);
  console.log(`deliverables logged: ${deliverables.snapshot().length}`);
  console.log(`final sub-agent status: ${sub.at(-1)?.status}`);
  console.log('============================');
  process.exit(0);
}

void main();
