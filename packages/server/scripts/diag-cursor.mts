/**
 * Throwaway diagnostic (not wired into the app): answer two questions with ground truth —
 *   1. What does `Cursor.models.list()` actually return? → the real id + variant params for
 *      "composer 2.5 fast" (so we stop guessing `composer-2`).
 *   2. Where does a LOCAL run stall? → create a local agent, send a trivial prompt, stream every
 *      SDKMessage with timestamps, and wait with a tight cap. If it never reaches a terminal state,
 *      the last logged event tells us where it wedged (CLI process, transport, model validation).
 *
 * Everything is bounded + force-exits so this can never itself hang the terminal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, Cursor } from '@cursor/sdk';

function loadEnvKey(name: string): string | undefined {
  try {
    const txt = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
  return process.env[name];
}

const ts = () => new Date().toISOString().slice(11, 23);
const RUN_CAP_MS = 45_000;

async function main() {
  const apiKey = loadEnvKey('CURSOR_API_KEY');
  if (!apiKey) {
    console.error('no CURSOR_API_KEY in .env');
    process.exit(1);
  }
  console.log(`[${ts()}] apiKey present (${apiKey.slice(0, 8)}…)`);

  // ---- 1) model catalog ---------------------------------------------------
  try {
    console.log(`[${ts()}] Cursor.models.list() …`);
    const models = await Cursor.models.list({ apiKey });
    for (const m of models) {
      const variants = (m.variants ?? [])
        .map((v) => `${v.displayName}{${v.params.map((p) => `${p.id}=${p.value}`).join(',')}}`)
        .join(' | ');
      console.log(
        `  • id=${m.id}  aliases=[${(m.aliases ?? []).join(',')}]  variants=[${variants}]`,
      );
    }
  } catch (err) {
    console.error(`[${ts()}] models.list FAILED:`, err instanceof Error ? err.message : err);
  }

  // ---- 2) timed REAL research run (forces file-search tools → needs ripgrep) ----
  const modelId = process.env.DIAG_MODEL || 'composer-2.5';
  const fast = process.env.DIAG_FAST !== 'false';
  const findings = '/tmp/diag-findings.html';
  console.log(
    `[${ts()}] CURSOR_RIPGREP_PATH=${process.env.CURSOR_RIPGREP_PATH ?? '(unset)'} ` +
      `model=${modelId} fast=${fast} cwd=${process.cwd()}`,
  );
  let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
  try {
    agent = await Agent.create({
      apiKey,
      name: 'diag',
      model: { id: modelId, params: fast ? [{ id: 'fast', value: 'true' }] : [] },
      local: { cwd: process.cwd() },
    });
    console.log(`[${ts()}] agent created; send() …`);
    const run = await agent.send(
      [
        'Investigate how the 4-second heartbeat brain loop works in THIS repository. You MUST use',
        'file-search/grep tools to find the relevant code. Cite specific file paths and line numbers',
        '(e.g. packages/server/src/core/orchestrator.ts). Write a short self-contained HTML findings',
        `document to EXACTLY this absolute path: ${findings}. Keep it brief.`,
      ].join(' '),
    );
    console.log(`[${ts()}] send() returned a run; streaming + waiting (cap ${RUN_CAP_MS}ms) …`);

    let events = 0;
    const streaming = (async () => {
      for await (const ev of run.stream()) {
        events += 1;
        const type =
          ev && typeof ev === 'object' && 'type' in ev ? (ev as { type: unknown }).type : '?';
        console.log(`[${ts()}]   stream#${events} type=${String(type)}`);
      }
      console.log(`[${ts()}] stream ENDED after ${events} events`);
    })().catch((e) => console.error(`[${ts()}] stream error:`, e));

    const capped = await Promise.race([
      run.wait().then((r) => ({ done: true as const, r })),
      new Promise<{ done: false }>((res) => {
        const t = setTimeout(() => res({ done: false }), RUN_CAP_MS);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    if (capped.done) {
      console.log(`[${ts()}] run.wait() RESOLVED:`, JSON.stringify(capped.r));
      await streaming;
    } else {
      console.log(`[${ts()}] *** STALLED *** run.wait() did not resolve in ${RUN_CAP_MS}ms (events seen: ${events})`);
      if (run.supports('cancel')) await run.cancel().catch(() => {});
    }
    // Did the agent actually WRITE a real findings file (proof the file-search tools worked)?
    try {
      const txt = readFileSync(findings, 'utf-8');
      console.log(`[${ts()}] FINDINGS WRITTEN: ${findings} (${txt.length} bytes)`);
      console.log(`[${ts()}] findings head: ${txt.replace(/\s+/g, ' ').slice(0, 240)}`);
    } catch {
      console.log(`[${ts()}] NO findings file at ${findings} (agent did not write it)`);
    }
  } catch (err) {
    console.error(`[${ts()}] local run threw:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
  } finally {
    try {
      agent?.close();
    } catch {}
  }
  console.log(`[${ts()}] done.`);
  process.exit(0);
}

void main();
