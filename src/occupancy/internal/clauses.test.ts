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

// Enough text for a page to be a page. A real lease page carries hundreds of
// characters and an image-only one carries its footer, which is the distinction
// `minPageChars` draws -- so a fixture about something else has to clear the bar
// rather than trip over it. The alternative, a threshold low enough for
// one-line fixtures, would let the real document's floor plan through.
function filler(y: number): PdfTextItem {
  return line(
    y,
    'הצדדים מצהירים כי קראו את ההסכם, הבינו את תוכנו ואת מלוא התחייבויותיהם על פיו.',
  );
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
        filler(140),
      ]),
    ]);
    assert.equal(chunks[0]?.text.split('\n')[0], 'דמי השכירות ישולמו מראש');
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
      page(13, [line(60, 'הודעה כאמור תימסר בכתב או במסרון.'), filler(90)]),
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
      page(1, [line(60, '1. תחילת ההסכם.'), filler(90)]),
      page(2, []),
      page(3, []),
      page(4, [line(60, '2. סיום ההסכם.'), filler(90)]),
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
  it('reads the annex form, where a clause names its number in words', () => {
    // נספח א׳ is a table of commercial terms keyed by the body clause each row
    // qualifies, so it writes `סעיף 5 – …` rather than leading with the number.
    // Measured on the real lease: without this the whole annex -- the term, the
    // rent, the maintenance fee, the securities -- came out as one chunk split
    // by length and cited as `נספח א׳ (1/2)`, which names two pages and not a
    // clause. That is the reference 13.1 would have had to build the twin on.
    const { chunks } = chunkLease([
      page(14, [
        line(40, 'נספח א׳ להסכם השכירות - תוספת תנאים מסחריים'),
        line(70, 'סעיף 3.2 – פגם, מום או ליקוי במושכר.'),
        line(100, 'סעיף 5 – תקופת השכירות שתחילתה ביום 15/08/2025.'),
        line(130, 'סעיף 10 - דמי השכירות החודשיים יעמדו על סך של 5,840 ש"ח.'),
      ]),
    ]);
    assert.deepEqual(
      chunks.map((chunk) => chunk.clauseRef),
      ['נספח א׳', 'נספח א׳ §3.2', 'נספח א׳ §5', 'נספח א׳ §10'],
    );
    // Each fact now sits in the clause that states it, which is what makes it
    // citable rather than merely present.
    assert.match(
      chunks.find((chunk) => chunk.clauseRef === 'נספח א׳ §10')?.text ?? '',
      /5,840/,
    );
  });

  it('does not take a mid-sentence reference for a clause start', () => {
    const { chunks } = chunkLease([
      page(3, [
        line(60, '4. השוכר יפעל כאמור להלן.'),
        line(80, 'הכל בכפוף לאמור בסעיף 12 להסכם זה.'),
      ]),
    ]);
    // One clause, not two: `סעיף` inside a sentence is a cross-reference, and
    // splitting there would cite the wrong clause for the text that follows.
    assert.deepEqual(
      chunks.map((chunk) => chunk.clauseRef),
      ['§4'],
    );
    assert.match(chunks[0]?.text ?? '', /בסעיף 12/);
  });
  it('counts a page carrying only its own page number as an image', () => {
    // The floor plan and the spec cover each carry a running footer, so each
    // yields one text item. Reading "has any text at all" as "is a page of
    // text" reported every page of the real lease as readable, against a
    // reference note that measured four image-only pages -- a false all-clear
    // on an incomplete document.
    const { chunks, imageOnlyPages } = chunkLease([
      page(23, [
        line(60, '18. השוכר יחזיר את המושכר במצב בו קיבלו, למעט בלאי סביר.'),
        filler(90),
      ]),
      page(24, [line(800, '- 24 -')]),
    ]);
    assert.deepEqual(imageOnlyPages, [24]);
    // And the footer went with it: a page number appended to the end of the
    // previous clause is not part of a contract.
    assert.equal(chunks.length, 1);
    assert.doesNotMatch(chunks[0]?.text ?? '', /- 24 -/);
    assert.equal(chunks[0]?.pageTo, 23);
  });

  it('keeps a short page that is genuinely a short page', () => {
    const short =
      '12. הודעות. כל הודעה תישלח בדואר רשום או תימסר ביד לכתובות שבנספח א׳.';
    const { chunks, imageOnlyPages } = chunkLease([page(9, [line(60, short)])]);
    assert.deepEqual(imageOnlyPages, []);
    assert.equal(chunks[0]?.clauseRef, '§12');
  });
  it('does not turn a wrapped sentence into a clause of its own', () => {
    // Measured on the real lease. Reading every leading number as a clause
    // invented `§18` out of a cross-reference that wrapped -- a three-word
    // fragment competing for rank against real clauses -- and, by the same
    // mechanism, `נספח י״ב §43` out of the parcel numbers "חלקה 43 ו-46",
    // citing a land registry entry as a contractual term.
    const { chunks } = chunkLease([
      page(2, [
        line(
          60,
          '2.5. ידוע לשוכר שהמתחם הוקם במסגרת מכרז, ועל כן יחולו הוראות סעיף',
        ),
        line(80, '18 להלן.'),
        line(
          120,
          '2.6. זכות השוכר תתמצה בזכות חוזית בלבד, והוא מתחייב שלא לרשום אותה.',
        ),
        filler(160),
      ]),
    ]);
    const refs = chunks.map((chunk) => chunk.clauseRef);
    assert.ok(!refs.includes('§18'));
    // And it is not lost either -- it belongs to the sentence it continues.
    assert.match(chunks[0]?.text ?? '', /18 להלן/);
  });

  it('still reads a real clause that carries no separator after its number', () => {
    // The other half of the rule, and why the test above is not simply "require
    // a full stop after the number": נספח י״א numbers its clauses `2.2.4` with
    // no separator at all, and they are real. Only a bare number *and* a
    // previous line still mid-sentence is conclusive.
    const { chunks } = chunkLease([
      page(35, [
        line(60, '2.2.3 מסירת דירה לשוכר חדש נעשית לאחר בדיקה.'),
        line(
          90,
          '2.2.4 מסירת דירה בעת החלפת שוכר מתבצעת בתיאום מראש עם הדיירים.',
        ),
        filler(130),
      ]),
    ]);
    assert.ok(chunks.some((chunk) => chunk.clauseRef?.includes('2.2.4')));
  });

  it('folds a bare heading into the clause it heads', () => {
    // `§6` alone is the line "6. מטרת השכירות וייחודה" and nothing else. On the
    // real lease it came seventh for a question about rent, purely on a shared
    // word -- retrieval that can return a heading is retrieval that can answer a
    // question with a table of contents.
    const { chunks } = chunkLease([
      page(4, [
        line(60, '6. מטרת השכירות וייחודה'),
        line(
          90,
          '6.1. מטרת השכירות הינה למגורים בלבד ולא לכל מטרה אחרת שהיא כלל.',
        ),
        line(120, '7. שירותי האחזקה ותקנון המתחם'),
        line(
          150,
          '7.1. השוכר מצהיר ומאשר בזאת כי ידוע לו שהוא שוכר דירה במתחם מגורים.',
        ),
      ]),
    ]);
    const refs = chunks.map((chunk) => chunk.clauseRef);
    assert.ok(!refs.includes('§6'));
    assert.ok(!refs.includes('§7'));
    // The citation points at the text; the heading is kept beside it, so a
    // caller can show the context without citing it.
    const first = chunks.find((chunk) => chunk.clauseRef === '§6.1');
    assert.equal(first?.heading, '6. מטרת השכירות וייחודה');
    assert.match(first?.text ?? '', /למגורים בלבד/);
  });

  it('does not fold a heading across an annex boundary', () => {
    const { chunks } = chunkLease([
      page(14, [
        line(60, 'נספח א׳ — פרטי העסקה'),
        line(
          90,
          'סעיף 5 – תקופת השכירות מתחילה ביום 15/08/2025 ומסתיימת בתום התקופה.',
        ),
        filler(130),
      ]),
    ]);
    // The annex heading is its own chunk: it is not a parent of `§5` in the
    // numbering sense, and merging them would cite the annex's preamble as the
    // clause about the term.
    assert.equal(chunks[0]?.clauseRef, 'נספח א׳');
    assert.equal(chunks[1]?.clauseRef, 'נספח א׳ §5');
  });
});
