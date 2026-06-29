/** Narrow an unknown to an object map without a type assertion. Mirrors the web's is-record.ts. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
