import type { NoOpArgs } from '@meeting-agent/protocol';

/** no_op: deliberately does nothing. The agent's default, most-common choice. */
export async function runNoOp(_args: NoOpArgs): Promise<void> {
  /** Intentionally empty — staying silent is the action. */
}
