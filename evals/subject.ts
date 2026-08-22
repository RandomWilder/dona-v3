import type { AgentTurn, Subject } from './case.ts';

// PLACEHOLDER. There is no agent yet — the channel module arrives in week 3
// (ROADMAP.md), and this file is what it replaces: `runCases` takes a Subject,
// so swapping the real agent in is a one-line change here and nothing else.
//
// The value in this slice is the wiring and the failure path, not this stub's
// answers. `runner.test.ts` grades a deliberately wrong subject to prove the
// runner can actually fail.

const emergencyWords = ['נזילה', 'הצפה', 'שריפה', 'ריח גז'];
const responsibilityWords = ['אחראי', 'מי משלם', 'על חשבון מי'];

export const placeholderSubject: Subject = async ({
  message,
}): Promise<AgentTurn> => {
  if (emergencyWords.some((word) => message.includes(word))) {
    return {
      text: 'פתחתי קריאה דחופה ואנחנו מטפלים בזה עכשיו.',
      refused: false,
      citations: [],
      toolCalls: ['case.open'],
    };
  }

  if (responsibilityWords.some((word) => message.includes(word))) {
    return {
      text: 'לפי סעיף 7.2 בחוזה, תיקוני בלאי סביר הם באחריות בעל הדירה.',
      refused: false,
      citations: ['חוזה §7.2'],
      toolCalls: [],
    };
  }

  return {
    text: 'אין לי את המידע הזה, ואני לא רוצה לנחש — אעביר את זה למשרד.',
    refused: true,
    citations: [],
    toolCalls: [],
  };
};
