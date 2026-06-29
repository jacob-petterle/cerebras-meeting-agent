import { describe, it, expect } from 'vitest';
import type { RenderCommand } from '@meeting-agent/protocol';
import { createScreenState } from '../packages/server/src/core/screen-state';

const render = (over: Partial<RenderCommand> = {}): RenderCommand => ({
  kind: 'html',
  payload: '<h1>hi</h1>',
  ...over,
});

describe('screen-state — the shared screen as honest session state', () => {
  it('starts empty (nothing on screen)', () => {
    expect(createScreenState().current()).toBeNull();
  });

  it('records OUR share with mine=true and the title as the label', () => {
    const s = createScreenState();
    s.noteOurShare(render({ title: 'ERD diagram' }), 1_000);
    expect(s.current()).toEqual({ label: 'ERD diagram', kind: 'html', since: 1_000, mine: true });
  });

  it('falls back to the kind when our render has no title', () => {
    const s = createScreenState();
    s.noteOurShare(render({ kind: 'mermaid', title: '   ' }), 2_000);
    expect(s.current()?.label).toBe('mermaid');
    expect(s.current()?.mine).toBe(true);
  });

  it('reflects an EXTERNAL presenter as mine=false (multi-share honesty)', () => {
    const s = createScreenState();
    s.noteOurShare(render({ title: 'my chart' }), 1_000);
    // Someone else grabs the screen — the brain must stop assuming its chart is visible.
    s.noteExternalShare({ active: true, presenter: 'Dylan', now: 5_000 });
    expect(s.current()).toEqual({ label: 'Dylan is sharing', kind: '', since: 5_000, mine: false });
  });

  it('clears when an external share stops, and we can take the screen back', () => {
    const s = createScreenState();
    s.noteExternalShare({ active: true, presenter: 'Dylan', now: 1_000 });
    s.noteExternalShare({ active: false, presenter: null, now: 2_000 });
    expect(s.current()).toBeNull();
    s.noteOurShare(render({ title: 'back to us' }), 3_000);
    expect(s.current()?.mine).toBe(true);
    expect(s.current()?.label).toBe('back to us');
  });

  it('labels an anonymous external share without a name', () => {
    const s = createScreenState();
    s.noteExternalShare({ active: true, presenter: null, now: 1_000 });
    expect(s.current()?.label).toBe('someone is sharing');
  });

  it('clear() empties the screen (session reset)', () => {
    const s = createScreenState();
    s.noteOurShare(render(), 1_000);
    s.clear();
    expect(s.current()).toBeNull();
  });
});
