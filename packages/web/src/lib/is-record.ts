/** Narrow `unknown` to an indexable object. Shared by the WS boundary validator and the stage sandbox bridge. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
