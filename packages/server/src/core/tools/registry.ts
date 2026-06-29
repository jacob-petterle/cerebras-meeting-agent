import {
  type CallAgentArgs,
  type DeliverableRecord,
  type SenderKind,
  type ToolCall,
  TOOL_ARGS,
} from '@meeting-agent/protocol';
import type { Ports } from '../ports';
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
  /** Returns the findings deliverable, or `null` when the research produced none (no fallbacks). */
  callAgent: (args: CallAgentArgs) => Promise<DeliverableRecord | null>;
}

export interface ToolRegistry {
  dispatch(call: ToolCall): Promise<TurnOutcome | null>;
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
          const args = TOOL_ARGS.share_screen.parse(call.args);
          await runShareScreen(args, { display: deps.ports.display });
          const label = args.title ?? args.kind;
          return { senderKind: 'tool', text: `shared a ${args.kind}: ${label}` };
        }
        case 'call_agent': {
          const args = TOOL_ARGS.call_agent.parse(call.args);
          const deliverable = await deps.callAgent(args);
          /**
           * No deliverable → the research produced no findings (timeout/error, no fallbacks). Append
           * nothing to the transcript; the brain already observed the terminal `error` on the
           * <sub_agents> resource and can decide whether to retry.
           */
          if (!deliverable) return null;
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
        case 'sleep': {
          /**
           * `sleep` is handled entirely by the orchestrator — it mutes the idle heartbeat and ends the
           * turn, exactly like no_op — and is never dispatched here. It IS a ToolName, so the exhaustive
           * switch must account for it; if one ever reaches the registry it's simply a no-op.
           */
          return null;
        }
        default:
          return assertNever(call.name);
      }
    },
  };
}
