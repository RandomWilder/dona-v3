import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PdfPage, PdfTextItem } from '../../kernel/pdf.ts';
import { chunkLease, maxChunkChars } from './clauses.ts';

// Pure unit tests, and the bulk of this slice's tests, because this is where
// the failures are: line assembly, the two-column annex, an annex boundary, a
// clause across a page break.
//
// The fixtures are built to the *structure* documented in
// docs/reference/lease-template-donadom.md and the content is invented. No line
// of the real lease is copied into this repo -- it is a signed contract with
// real names and ID numbers, and it lives only in the buckets (tasks/fuses.md).

const pageWidth = 595;
const pageHeight = 842;

// A text run placed by its LEFT edge, in the top-down coordinates the kernel
// adapter hands over. Hebrew is laid out right to left, so the run that reads
// first is the one furthest right.
function run(x: number, y: number, text: string, width = 120): PdfTextItem {
  return {
    text,
    x,
    y,
    width,
    height: 11,
    rightToLeft: /[א-ת]/.test(text),
    endsLine: true,
  };
}

function page(number: number, items: PdfTextItem[]): PdfPage {
  return { number, width: pageWidth, height: pageHeight, items };
}

// One right-aligned line of body text, the shape most of a lease is.
function line(y: number, text: string): PdfTextItem {
  return run(150, y, text, 340);
}

// A נספח א׳ row: the label on the right, its value in the left column, both on
// one baseline. This is the layout the reference note names as the reason
// clause-aware chunking is required rather than merely tidier.
function labelled(y: number, label: string, value: string): PdfTextItem[] {
  return [run(380, y, label, 100), run(120, y, value, 90)];
}

describe('clause chunking', () => {
  it('reads a right-to-left line rightmost run first', () => {
    const { chunks } = chunkLease([
      page(1, [
        run(400, 100, 'דמי השכירות', 90),
        run(330, 100, 'ישולמו מראש', 60),
      ]),
    ]);
    assert.equal(chunks[0]?.text, 'דמי השכירות ישולמו מראש');
  });

  it('binds a value to its own label and not to the label above it', () => {
    // The failure this test exists for: read by reading order alone, this page
    // yields "…השכירות / 24 / …מספר דירה / 4,200" and a lease that answers the
    // rent question with a flat number. Each row must close over its own value.
    const { chunks } = chunkLease([
      page(1, [
        run(380, 80, 'נספח א׳ — פרטי העסקה', 200),
        ...labelled(120, 'תקופת השכירות', '24 חודשים'),
        ...labelled(150, 'דמי שכירות חודשיים', '4,200 ש"ח'),
        ...labelled(180, 'דמי אחזקה', '310 ש"ח'),
      ]),
    ]);
    const text = chunks.map((chunk) => chunk.text).join('\n');
    assert.match(text, /תקופת השכירות: 24 חודשים/);
    assert.match(text, /דמי שכירות חודשיים: 4,200 ש"ח/);
    assert.match(text, /דמי אחזקה: 310 ש"ח/);
    // And the value never appears loose, which is what a wrong pairing looks
    // like from the outside.
    assert.doesNotMatch(text, /\n4,200/);
  });

  it('carries the annex into the reference, because numbering restarts in each', () => {
    const { chunks } = chunkLease([
      page(1, [
        line(60, 'נספח א׳ — פרטי העסקה'),
        line(90, '3. הדירה המושכרת היא דירה בת שלושה חדרים.'),
        line(200, 'נספח י״ב — תוספת בגין איחור במסירה'),
        line(230, '3. הפיצוי המוסכם ישולם בתום שלושים יום.'),
      ]),
    ]);
    const refs = chunks.map((chunk) => chunk.clauseRef);
    assert.ok(refs.includes('נספח א׳ §3'));
    assert.ok(refs.includes('נספח י״ב §3'));
    // Same number, different clause. Collapsing them would cite one annex's
    // text under the other annex's rule.
    assert.notEqual(
      chunks.find((chunk) => chunk.clauseRef === 'נספח א׳ §3')?.text,
      chunks.find((chunk) => chunk.clauseRef === 'נספח י״ב §3')?.text,
    );
  });

  it('keeps a clause that crosses a page break as one chunk with two pages', () => {
    const { chunks } = chunkLease([
      page(12, [
        line(700, '14. השוכר יאפשר לבעלים גישה לדירה לצורך תיקונים,'),
        line(720, 'ובלבד שנמסרה הודעה מוקדמת של 24 שעות.'),
      ]),
      page(13, [line(60, 'הודעה כאמור תימסר בכתב או במסרון.')]),
    ]);
    const clause = chunks.find((chunk) => chunk.clauseRef === '§14');
    assert.equal(clause?.pageFrom, 12);
    assert.equal(clause?.pageTo, 13);
    assert.match(clause?.text ?? '', /במסרון/);
  });

  it('gives a preamble a null reference rather than an invented one', () => {
    const { chunks } = chunkLease([
      page(1, [
        line(300, 'הסכם שכירות בלתי מוגנת'),
        line(330, 'שנערך ונחתם בבית שמש'),
        line(400, '1. המבוא להסכם זה מהווה חלק בלתי נפרד ממנו.'),
      ]),
    ]);
    assert.equal(chunks[0]?.clauseRef, null);
    assert.match(chunks[0]?.text ?? '', /הסכם שכירות/);
    assert.equal(chunks[1]?.clauseRef, '§1');
  });

  it('names the pages it could not read instead of dropping them', () => {
    // Four pages of the sample lease are images: a placeholder, the floor plan,
    // a spec cover and one page of tables. OCR is week 3's cut line, so the
    // honest output is a lease that says which pages are missing from it.
    const { chunks, imageOnlyPages } = chunkLease([
      page(1, [line(60, '1. תחילת ההסכם.')]),
      page(2, []),
      page(3, []),
      page(4, [line(60, '2. סיום ההסכם.')]),
    ]);
    assert.deepEqual(imageOnlyPages, [2, 3]);
    assert.deepEqual(
      chunks.map((chunk) => chunk.clauseRef),
      ['§1', '§2'],
    );
  });

  it('merges short sub-clauses of one parent into a range, and stops at the parent', () => {
    const { chunks } = chunkLease([
      page(5, [
        line(60, '7.1 השוכר ישלם את דמי השכירות.'),
        line(80, '7.2 התשלום יבוצע בהוראת קבע.'),
        line(100, '7.3 איחור יישא ריבית.'),
        line(140, '8.1 הבעלים יבטח את המבנה.'),
      ]),
    ]);
    const refs = chunks.map((chunk) => chunk.clauseRef);
    assert.deepEqual(refs, ['§7.1–7.3', '§8.1']);
    // The merged chunk holds all three, so nothing was lost to the merge.
    assert.match(chunks[0]?.text ?? '', /הוראת קבע/);
    assert.match(chunks[0]?.text ?? '', /ריבית/);
  });

  it('splits an over-long clause into numbered parts of the same reference', () => {
    const long = Array.from(
      { length: 40 },
      (_, index) => `שורה ${index} של סעיף ארוך במיוחד הממשיך על פני עמוד שלם.`,
    );
    const { chunks } = chunkLease([
      page(9, [
        line(40, '19. הוראות כלליות.'),
        ...long.map((text, index) => line(60 + index * 18, text)),
      ]),
    ]);
    const parts = chunks.filter((chunk) => chunk.clauseRef?.startsWith('§19'));
    assert.ok(parts.length > 1);
    assert.equal(parts[0]?.clauseRef, `§19 (1/${parts.length})`);
    // Length decides where a chunk ends. It never decides what the chunk is
    // called, so every part still names clause 19.
    for (const part of parts) {
      assert.ok(part.text.length <= maxChunkChars);
      assert.match(part.clauseRef ?? '', /^§19 \(\d+\/\d+\)$/);
    }
  });

  it('numbers chunks contiguously from zero', () => {
    const { chunks } = chunkLease([
      page(1, [
        line(60, '1. ראשון.'),
        line(90, '2. שני.'),
        line(120, '3. שלישי.'),
      ]),
    ]);
    assert.deepEqual(
      chunks.map((chunk) => chunk.ordinal),
      chunks.map((_, index) => index),
    );
  });

  it('returns nothing at all for a document with no text layer', () => {
    const { chunks, imageOnlyPages } = chunkLease([page(1, []), page(2, [])]);
    assert.deepEqual(chunks, []);
    assert.deepEqual(imageOnlyPages, [1, 2]);
  });
});
