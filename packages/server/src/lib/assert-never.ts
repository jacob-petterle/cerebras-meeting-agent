/**
 * Exhaustiveness helper for discriminated unions. Placing the unreachable value in the `never`
 * position makes the compiler flag any unhandled variant at the call site; if control somehow
 * reaches here at runtime (an off-contract value), it throws rather than failing silently.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}
