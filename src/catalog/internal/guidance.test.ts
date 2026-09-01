import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkGuidance, maxSectionChars } from './guidance.ts';

// Pure unit tests, no database. What a policy document is cut into, and how a
// citation into one is spelled.

describe('guidance chunking', () => {
  it('cuts on headings and cites each section by its own heading', () => {
    const { title, chunks } = chunkGuidance(
      [
        '# נוהל פנייה למשרד',
        '',
        '## שעות פעילות',
        'המשרד פתוח בימים ראשון עד חמישי בין 09:00 ל-17:00.',
        '',
        '## דרכי פנייה',
        'פנייה בכתב היא הדרך המועדפת.',
        '',
      ].join('\n'),
    );
    assert.equal(title, 'נוהל פנייה למשרד');
    assert.deepEqual(
      chunks.map((chunk) => chunk.headingRef),
      ['נוהל פנייה למשרד § שעות פעילות', 'נוהל פנייה למשרד § דרכי פנייה'],
    );
    assert.match(chunks[0]?.text ?? '', /09:00/);
    assert.match(chunks[1]?.text ?? '', /בכתב/);
  });

  it('cites the text above the first heading by the document itself', () => {
    // A lease has to admit a chunk nothing can cite -- a cover page carries no
    // clause number. Markdown we author has no such thing, which is why
    // `headingRef` is NOT NULL in the schema.
    const { chunks } = chunkGuidance(
      [
        '# נוהל דיווח על תקלה',
        '',
        'נוהל זה מתאר כיצד מדווחים על תקלה ומה קורה לאחר הדיווח.',
        '',
        '## מה נחשב מקרה חירום',
        'ריח גז, שריפה או הצפה פעילה.',
      ].join('\n'),
    );
    assert.equal(chunks[0]?.headingRef, 'נוהל דיווח על תקלה');
    assert.equal(chunks[0]?.heading, null);
    assert.equal(
      chunks[1]?.headingRef,
      'נוהל דיווח על תקלה § מה נחשב מקרה חירום',
    );
    // Every section is citable, with nothing to exclude from the index.
    assert.ok(chunks.every((chunk) => chunk.headingRef.length > 0));
  });

  it('keeps a sub-heading inside the section it subdivides', () => {
    // `###` narrows a topic rather than changing it, and a citation naming the
    // `##` is the one a reader can find on the page.
    const { chunks } = chunkGuidance(
      [
        '# נוהל כניסה לדירה',
        '',
        '## תיאום מראש',
        'הודעה נמסרת 24 שעות מראש.',
        '',
        '### דחיית מועד',
        'דייר רשאי לבקש מועד חלופי אחד.',
      ].join('\n'),
    );
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.headingRef, 'נוהל כניסה לדירה § תיאום מראש');
    assert.match(chunks[0]?.text ?? '', /דחיית מועד/);
  });

  it('numbers chunks contiguously from zero', () => {
    const { chunks } = chunkGuidance(
      [
        '# נוהל',
        '',
        '## א',
        'טקסט',
        '',
        '## ב',
        'טקסט',
        '',
        '## ג',
        'טקסט',
      ].join('\n'),
    );
    assert.deepEqual(
      chunks.map((chunk) => chunk.ordinal),
      [0, 1, 2],
    );
  });

  it('splits an over-long section without changing what it is called', () => {
    const paragraph = `${'א'.repeat(400)}`;
    const long = Array.from({ length: 6 }, () => paragraph).join('\n\n');
    const { chunks } = chunkGuidance(
      ['# נוהל ארוך', '', '## סעיף ארוך', long].join('\n'),
    );
    assert.ok(chunks.length > 1);
    // Length decides where a chunk ends; it never decides what a chunk is
    // called, so a citation still points at a place a reader can turn to.
    assert.ok(
      chunks.every((chunk) => chunk.headingRef === 'נוהל ארוך § סעיף ארוך'),
    );
    assert.ok(chunks.every((chunk) => chunk.text.length <= maxSectionChars));
  });

  it('refuses a document with no title rather than inventing one', () => {
    // A citation naming a file path is not something a tenant can check, and a
    // default title is one more thing nobody notices is wrong.
    assert.throws(
      () => chunkGuidance('## שעות פעילות\nהמשרד פתוח.'),
      /must open with a `# title` line/,
    );
  });

  it('does not let a second title line replace the first', () => {
    // A renamed document would otherwise change every citation in it, halfway
    // down the file.
    const { title, chunks } = chunkGuidance(
      ['# נוהל אחד', '', '## סעיף', 'טקסט', '# נוהל שני', 'עוד טקסט'].join(
        '\n',
      ),
    );
    assert.equal(title, 'נוהל אחד');
    assert.match(chunks[0]?.text ?? '', /# נוהל שני/);
  });
});
