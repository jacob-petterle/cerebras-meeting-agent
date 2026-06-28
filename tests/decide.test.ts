import { describe, it, expect } from 'vitest';
import { toDecision } from '../packages/server/src/core/decide';
import type { AssembledToolCall } from '../packages/server/src/core/cerebras';

/**
 * decide.ts `toDecision` — the off-contract → no_op funnel. The model can emit an unknown tool, bad
 * JSON, or args that don't satisfy the tool's Zod schema; every such case must collapse to no_op
 * rather than dispatch a malformed action. A well-formed call passes through with parsed args.
 */

const call = (over: Partial<AssembledToolCall>): AssembledToolCall => ({
  index: 0,
  id: 'c0',
  name: 'no_op',
  arguments: '{}',
  ...over,
});

describe('toDecision (bias to no_op on anything off-contract)', () => {
  it('a valid tool call → that decision, with Zod-parsed args', () => {
    const d = toDecision(call({ name: 'speak', arguments: '{"text":"hello"}' }));
    expect(d).toEqual({ name: 'speak', args: { text: 'hello' } });
  });

  it('a valid share_screen call keeps its optional fields (deliverableId)', () => {
    const d = toDecision(
      call({ name: 'share_screen', arguments: '{"kind":"json","payload":"{}","deliverableId":"d1"}' }),
    );
    expect(d).toEqual({
      name: 'share_screen',
      args: { kind: 'json', payload: '{}', deliverableId: 'd1' },
    });
  });

  it('an undefined call (no tool emitted) → no_op', () => {
    expect(toDecision(undefined)).toEqual({ name: 'no_op', args: {} });
  });

  it('an unknown tool name → no_op', () => {
    const d = toDecision(call({ name: 'delete_everything', arguments: '{"yes":true}' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('unparsable JSON args → no_op', () => {
    const d = toDecision(call({ name: 'speak', arguments: '{"text": "unterminated' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('args that fail the per-tool Zod schema → no_op', () => {
    // speak requires { text: string }; a number must fail the schema and fall back to no_op.
    const d = toDecision(call({ name: 'speak', arguments: '{"text": 42}' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('a call_agent with an empty task fails the .min(1) schema → no_op', () => {
    const d = toDecision(call({ name: 'call_agent', arguments: '{"task":""}' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('empty argument string is treated as {} and validated (no_op with empty args is valid)', () => {
    const d = toDecision(call({ name: 'no_op', arguments: '' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });
});
