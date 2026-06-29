import { describe, expect, it } from 'vitest';
import { isResetCommand } from './reset-phrase';

describe('isResetCommand', () => {
  it('matches explicit reset intents (case / punctuation / spacing insensitive)', () => {
    const yes = [
      'Atlas, let’s start fresh',
      "let's start over",
      'can we start a new session',
      'Start  Over',
      'please start from scratch',
      'clear the context',
      'reset the session',
      'wipe the transcript',
      'clear everything',
      'new session',
      'fresh start',
      'CLEAR THE CONVERSATION.',
    ];
    for (const t of yes) expect(isResetCommand(t), t).toBe(true);
  });

  it('does NOT fire on ordinary conversation (no false resets mid-meeting)', () => {
    const no = [
      '',
      '   ',
      'let me start by summarizing the roadmap',
      'we should start the demo now',
      'the new feature is ready',
      'can you clear that up for me',
      'I reset my password yesterday',
      'this session has been productive',
      'start the recording please',
    ];
    for (const t of no) expect(isResetCommand(t), t).toBe(false);
  });
});
