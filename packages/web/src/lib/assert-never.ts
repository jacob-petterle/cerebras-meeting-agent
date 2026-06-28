/**
 * Compile-time exhaustiveness guard for discriminated unions WE own (e.g. the
 * stage's RenderKind switch). Untrusted network input is NOT funnelled through
 * this -- it gets Zod-validated and ignored-on-mismatch instead (see validate.ts).
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`);
}
