import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCodebase, renderCodebaseResource } from '../packages/server/src/core/codebase';

describe('describeCodebase — the attached repo identity', () => {
  it('reads name + description from package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-proj', description: 'a cool thing' }));
      const info = describeCodebase(dir);
      expect(info.name).toBe('my-proj');
      expect(info.description).toBe('a cool thing');
      expect(info.root).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the directory name when there is no package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fallback-'));
    try {
      const info = describeCodebase(dir);
      expect(info.name).toBe(dir.split('/').pop());
      expect(info.description).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws on a malformed package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{ not valid json');
      expect(() => describeCodebase(dir)).not.toThrow();
      expect(describeCodebase(dir).description).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderCodebaseResource', () => {
  it('renders a self-closing <codebase> block with name + the call_agent hint', () => {
    const out = renderCodebaseResource({ name: 'cerebras-meeting-agent', root: '/repo', description: 'AI meeting agent' });
    expect(out).toMatch(/^<codebase\b[^>]*\/>$/);
    expect(out).toContain('name="cerebras-meeting-agent"');
    expect(out).toContain('description="AI meeting agent"');
    expect(out).toContain('call_agent');
  });

  it('omits description when empty and escapes attributes', () => {
    const out = renderCodebaseResource({ name: 'a & "b" <c>', root: '/r', description: '' });
    expect(out).not.toContain('description=');
    expect(out).toContain('name="a &amp; &quot;b&quot; &lt;c&gt;"');
  });
});
