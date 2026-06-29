import { readFileSync } from 'node:fs';
import {
  type CallAgentArgs,
  type DeliverableRecord,
  type SenderKind,
  type ShareScreenArgs,
  type ToolCall,
  TOOL_ARGS,
} from '@meeting-agent/protocol';
import type { Ports } from '../ports';
import type { AppendLog } from '../resources';
import { assertNever } from '../../lib/assert-never';
import { runSpeak, type TtsFn, type TtsResult } from './speak';
import { runShareScreen } from './shareScreen';
import { runNoOp } from './noop';

export type { TtsResult, TtsFn } from './speak';

/**
 * Tool registry — the single dispatch boundary from a parsed tool call to a side effect.
 *
 * Every call is validated against its TOOL_ARGS Zod schema HERE, at the boundary, before any
 * effect runs (a malformed `speak {}` throws and never reaches TTS). Routing goes only through the
 * injected ports + the injected TTS / call_agent functions — no media or model code is imported.
 *
 * dispatch RETURNS a {@link TurnOutcome} describing what the agent just did, so the caller (main.ts)
 * can append it to the transcript log: this gives the model memory of its own prior turns and lights
 * up the web console's Tools/Agent tabs + HUD. `no_op` returns null (nothing happened to record).
 */

/**
 * What a non-no_op dispatch produced, for the transcript write-back. `senderKind` distinguishes the
 * agent speaking (`agent`) from a tool side effect surfaced as a turn (`tool`).
 */
export interface TurnOutcome {
  senderKind: Extract<SenderKind, 'agent' | 'tool'>;
  text: string;
}

export interface RegistryDeps {
  ports: Ports;
  tts: TtsFn;
  callAgent: (args: CallAgentArgs) => Promise<DeliverableRecord>;
  /**
   * The deliverables log, for resolving `share_screen { deliverableId }` to the actual sub-agent
   * findings file server-side. Optional: when omitted (e.g. unit tests that don't exercise this),
   * `share_screen` renders the model's payload verbatim — the prior behavior.
   */
  deliverables?: AppendLog<DeliverableRecord>;
  /**
   * Reads a deliverable's file by path (injected so tests don't touch the disk). Defaults to a
   * UTF-8 `readFileSync`. Only used when `deliverables` is set and the id resolves to a `filePath`.
   */
  readFile?: (path: string) => string;
}

export interface ToolRegistry {
  dispatch(call: ToolCall): Promise<TurnOutcome | null>;
}

/** Default file reader for resolved deliverables — UTF-8, always returns a string. */
function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * Resolve a `share_screen` to a render payload. When the call carries a `deliverableId` that maps to
 * a deliverable with a `filePath`, we read that file and render its REAL contents as `html` — so a
 * shared sub-agent result shows the actual findings, not a re-summarized payload the model invented.
 * Defensive: any miss (no id, unknown id, no filePath, unreadable file) falls back to the model's
 * own `kind`/`payload`. Never throws.
 */
function resolveShareScreenArgs(
  args: ShareScreenArgs,
  deliverables: AppendLog<DeliverableRecord> | undefined,
  readFile: (path: string) => string,
): ShareScreenArgs {
  if (!deliverables || args.deliverableId === undefined) return args;
  const match = deliverables.snapshot().find((e) => e.data.id === args.deliverableId);
  const filePath = match?.data.filePath;
  if (!filePath) return args;
  try {
    const contents = readFile(filePath);
    if (contents.trim().length === 0) return args;
    /** Override with the real file as html; keep the title/id so the stage labels it the same. */
    return { ...args, kind: 'html', payload: contents };
  } catch {
    /** Unreadable file → fall back to the model's payload (current behavior). */
    return args;
  }
}

export function createRegistry(deps: RegistryDeps): ToolRegistry {
  return {
    async dispatch(call: ToolCall): Promise<TurnOutcome | null> {
      switch (call.name) {
        case 'speak': {
          /**
           * Deliberate `.parse()` (throws), not the project's safeParse-at-boundaries rule: this
           * registry is a last-line sanity check, not the boundary. Off-contract args are already
           * filtered upstream in decide.ts (collapsed to no_op), so a throw here means a genuine
           * internal bug, which should surface loudly rather than be swallowed.
           */
          const args = TOOL_ARGS.speak.parse(call.args);
          await runSpeak(args, { tts: deps.tts, audioOut: deps.ports.audioOut });
          return { senderKind: 'agent', text: args.text };
        }
        case 'share_screen': {
          const parsed = TOOL_ARGS.share_screen.parse(call.args);
          /** Swap in the real deliverable file contents when the call references one (Task C). */
          const args = resolveShareScreenArgs(parsed, deps.deliverables, deps.readFile ?? defaultReadFile);
          await runShareScreen(args, { display: deps.ports.display });
          const label = args.title ?? args.kind;
          return { senderKind: 'tool', text: `shared a ${args.kind}: ${label}` };
        }
        case 'call_agent': {
          const args = TOOL_ARGS.call_agent.parse(call.args);
          const deliverable = await deps.callAgent(args);
          return {
            senderKind: 'tool',
            text: `researched: ${args.task} (deliverable ${deliverable.id})`,
          };
        }
        case 'no_op': {
          const args = TOOL_ARGS.no_op.parse(call.args);
          await runNoOp(args);
          return null;
        }
        default:
          return assertNever(call.name);
      }
    },
  };
}
