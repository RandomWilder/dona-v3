import type { PdfPage, PdfTextItem } from '../../kernel/pdf.ts';

// A lease, cut into the clauses a citation can name. Its own unit, pure: no
// clock, no pool, no store and no network -- as roles.ts, dates.ts and paths.ts
// are. Everything hard about ingestion is in here, which is why it is the piece
// with no I/O in it: a test can state a page's geometry and assert what came
// out.
//
// The shape of the document this reads is documented, measured, in
// docs/reference/lease-template-donadom.md. Two of its findings are the whole
// design:
//
//   - The body is boilerplate; the facts live in the annexes, and clause
//     numbering restarts inside each one. So `נספח א׳ §3` and `נספח י״ב §3` are
//     different clauses, and the annex has to be carried in the reference.
//   - נספח א׳ is a two-column label/value table, and the difficulty is layout
//     rather than characters. Text flattened by reading order alone binds each
//     value to the label on the line above it, which is how a lease comes to
//     answer "what is the rent" with the maintenance fee.

export interface LeaseChunk {
  ordinal: number;
  // What a citation says: 'נספח א׳ §3.2', '§14.1', '§14 (2/3)'. Null for a
  // cover page, a preamble or a signature block -- text that is really in the
  // document and really has no clause number. An invented reference would be a
  // citation pointing at nothing.
  clauseRef: string | null;
  heading: string | null;
  text: string;
  pageFrom: number;
  pageTo: number;
}

// Which chunks retrieval may return. Both halves of it say the same thing --
// this chunk cannot answer anything -- and neither removes a chunk from the
// document: `chunkLease` still produces them, they are still stored, and
// `listChunks` still shows them. What they do not get is a vector.
//
// **No clause reference** is a cover page, a preamble or a signature block.
// Nothing can cite it, so the only thing a caller could do with it is feed it to
// a model unattributed -- and slice 14.1a measured it as the chunk that wins
// questions it has nothing to do with, while being the PII-densest text in the
// lease. Not embedding it is therefore an accuracy decision and a privacy one at
// once: the parties' names and ID numbers never reach the embedding provider,
// which is the rule `twin.ts` already applies to extraction, reached from the
// other side.
//
// **Text that is only its own heading** is a label: `נספח א׳ — פרטי העסקה` and
// nothing else. It is the argument `coalesce` makes for a bare parent heading,
// applied to the one case `coalesce` deliberately leaves alone -- an annex
// heading is not the parent of the clauses inside it, and folding them would
// cite an annex's preamble as the clause about the term. An annex that *has* a
// preamble says more than its heading and stays indexed; one that is a title and
// a page break does not.
export function isRetrievable(chunk: {
  clauseRef: string | null;
  heading: string | null;
  text: string;
}): boolean {
  if (chunk.clauseRef === null) {
    return false;
  }
  return chunk.heading === null || chunk.text.trim() !== chunk.heading.trim();
}

export interface LeaseChunking {
  chunks: LeaseChunk[];
  // Pages that carried no text layer, named rather than counted: a complete
  // lease is not one file (two annexes of the sample say their content was
  // emailed separately), so ingestion must be able to say what it could not
  // read instead of returning a document four pages shorter than the document.
  imageOnlyPages: number[];
}

// Sizing, in characters. A chunk is one clause first and a length second: these
// two only decide what happens to a clause that is unusually short or long, and
// neither is ever allowed to move where a citation points.
export const maxChunkChars = 1500;
export const minChunkChars = 200;

// Below this much readable text, a page is an image with a page number printed
// on it -- not a page of text.
//
// Measured on the real lease, and this number exists because the first cut of
// 12.1 got it wrong. Flagging only pages that yield *zero* text items reported
// "בכל העמודים נמצא טקסט" for a document the reference note measured as having
// four image-only pages: the floor plan and the spec cover each carry a running
// footer, so each yielded one item and passed for a page of prose. A false
// all-clear on an incomplete document is worse than saying nothing, because the
// operator reading an answer out of it has been told there is nothing missing.
//
// A page under the bar is also dropped rather than chunked, which takes the
// footer with it: `- 15 -` appended to the end of the previous clause is a page
// number pretending to be part of a contract.
export const minPageChars = 40;

// `נספח א׳`, `נספח י״ב` -- Hebrew letters used as a numeral. Anchored: the word
// appears inside sentences too ("as set out in נספח ב׳"), and only a line that
// *begins* with it is a heading.
//
// **The geresh is required unless the marker is a single letter**, and that is
// not cosmetic. `נספח זה מפרט את התנאים...` -- "this annex sets out the terms",
// the way an annex's own preamble opens -- was read as an annex lettered ז, and
// every clause after it was then numbered `נספח זה §…`: a citation naming an
// annex that does not exist. It is the same class of defect as a wrapped
// sentence read as a clause number (see `startsClause`), and the same fix --
// a marker has to look like a marker rather than merely start like one.
const annexHeading = /^נספח\s+([א-ת]["'׳״][א-ת]?|[א-ת])(?=[\s—–\-:.,)]|$)/;

// `14.`, `3.2`, `12.1.4` at the start of a line. The trailing separator is
// optional because typesetting varies between the body and the annexes.
const clauseNumber = /^(\d+(?:\.\d+)*)[.)]?(?:\s|$)/;

// The other way a clause announces itself, and the one the annexes use:
// `סעיף 5 – תקופת השכירות`. נספח א׳ is a table of commercial terms keyed by the
// body clause each row qualifies, so it names the number in words rather than
// leading with it.
//
// Measured on the real lease: without this, נספח א׳ -- the annex the digital
// twin reads, holding the term structure, the rent, the maintenance fee and the
// securities -- came out as one chunk split by length and cited as
// `נספח א׳ (1/2)`, a reference naming two pages rather than a clause.
//
// Anchored, and a number is required after the word: `סעיף` appears mid-sentence
// throughout a lease ("כאמור בסעיף 12"), and only a line that opens with it is a
// heading.
const clauseWord = /^סעיף\s+(\d+(?:\.\d+)*)\s*[–—\-:.]?/;

const hebrew = /[א-ת]/;

// A line that ends mid-sentence: no terminal punctuation, so whatever follows is
// a continuation of it rather than something new.
const endsSentence = /[.:;!?]\s*$/;

// `2.5.` and `10.1.` carry a separator after the number; `2.2.4 מסירת דירה` does
// not, and both are real clauses in this document. So the separator alone cannot
// decide -- but combined with the line before it, it can.
const numberedWithSeparator = /^\d+(?:\.\d+)*[.)]/;

interface Line {
  page: number;
  text: string;
}

export function chunkLease(pages: PdfPage[]): LeaseChunking {
  const imageOnlyPages: number[] = [];
  const lines: Line[] = [];
  for (const page of pages) {
    const read = page.items.length === 0 ? [] : pageLines(page);
    // Whitespace does not count: a page of blank runs is as unreadable as a
    // page of none.
    if (read.join('').replace(/\s/g, '').length < minPageChars) {
      imageOnlyPages.push(page.number);
      continue;
    }
    for (const text of read) {
      lines.push({ page: page.number, text });
    }
  }
  const chunks = split(coalesce(gather(lines)));
  return {
    chunks: chunks.map((chunk, index) => ({ ...chunk, ordinal: index })),
    imageOnlyPages,
  };
}

// --- geometry -------------------------------------------------------------

// The items on a page, assembled into lines in reading order.
//
// Two paths, because a lease has two kinds of page. Most of it is prose, where
// a line is a baseline and reading order is enough. `נספח א׳` is a two-column
// label/value table, where a baseline is not a line at all -- see `splitColumns`
// and the braid it exists to undo.
function pageLines(page: PdfPage): string[] {
  const table = splitColumns(page);
  return table
    ? tableLines(table, page.width)
    : proseLines(page.items, page.width);
}

function proseLines(items: PdfTextItem[], pageWidth: number): string[] {
  const assembled: string[] = [];
  for (const row of groupByBaseline(items)) {
    const text = joinRow(row, pageWidth);
    if (text.length > 0) {
      assembled.push(text);
    }
  }
  return assembled;
}

// Items sharing a baseline are one line. The tolerance is drawn from the text
// itself rather than fixed, because a page mixes a 20pt heading with 10pt body
// and one constant cannot suit both.
function groupByBaseline(items: PdfTextItem[]): PdfTextItem[][] {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const tolerance = Math.max(medianHeight(sorted) * 0.6, 2);

  const rows: PdfTextItem[][] = [];
  let current: PdfTextItem[] = [];
  let baseline = Number.NaN;
  for (const item of sorted) {
    if (current.length === 0) {
      baseline = item.y;
      current.push(item);
      continue;
    }
    if (Math.abs(item.y - baseline) <= tolerance) {
      current.push(item);
      continue;
    }
    rows.push(current);
    current = [item];
    baseline = item.y;
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows;
}

// One line's items, in the order a reader reads them, joined into text.
//
// A right-to-left line is ordered by its items' *right* edges descending. The
// direction is decided from the content rather than from pdfjs's `dir`, which
// reports `ltr` for a run of digits sitting inside a Hebrew line -- and a lease
// is full of those.
function joinRow(row: PdfTextItem[], pageWidth: number): string {
  const rightToLeft = row.some((item) => hebrew.test(item.text));
  const ordered = [...row].sort((a, b) =>
    rightToLeft ? b.x + b.width - (a.x + a.width) : a.x - b.x,
  );

  // Runs separated by a point or two are words; runs separated by a large gap
  // are separate *columns*, and that distinction is the two-column annex
  // working or not working.
  const columnGap = columnGapOf(pageWidth);
  const clusters: string[] = [];
  let cluster = '';
  let previous: PdfTextItem | null = null;
  for (const item of ordered) {
    if (previous === null) {
      cluster = item.text;
      previous = item;
      continue;
    }
    const gap = distance(previous, item, rightToLeft);
    if (gap > columnGap) {
      clusters.push(cluster);
      cluster = item.text;
    } else {
      cluster += gap > 1.5 ? ` ${item.text}` : item.text;
    }
    previous = item;
  }
  if (cluster.length > 0) {
    clusters.push(cluster);
  }

  const cleaned = clusters.map(collapse).filter((text) => text.length > 0);
  if (cleaned.length === 0) {
    return '';
  }
  if (cleaned.length === 1) {
    return cleaned[0] as string;
  }
  // Two columns is a label and its value, and binding them here is the point:
  // no later reader can pair the value with the wrong label, because there is
  // no longer a loose value to pair. Three or more is a table row, and the
  // separator says so rather than pretending the cells are a sentence.
  if (cleaned.length === 2) {
    const [label, value] = cleaned as [string, string];
    return bind(label, value);
  }
  return cleaned.join(' | ');
}

// A label and the value that belongs to it, joined so that no later reader can
// separate them again. The colon is added unless the label already ends in one.
function bind(label: string, value: string): string {
  return /[:：]$/.test(label) ? `${label} ${value}` : `${label}: ${value}`;
}

function distance(
  previous: PdfTextItem,
  item: PdfTextItem,
  rightToLeft: boolean,
): number {
  return rightToLeft
    ? previous.x - (item.x + item.width)
    : item.x - (previous.x + previous.width);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// The height of a typical glyph on a page, which is what both a baseline
// tolerance and a blank line are measured in. A page mixes a 20pt heading with
// 10pt body, so one constant cannot suit both.
function medianHeight(items: PdfTextItem[]): number {
  const heights = items
    .map((item) => item.height)
    .filter((height) => height > 0);
  return heights.length > 0 ? median(heights) : 10;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

// --- the two-column annex -------------------------------------------------

// `נספח א׳` is a label/value table, and slice 12.1 only half solved it. Binding
// two runs that share a baseline (`joinRow`) fixed the easy half: a value can no
// longer pair with the label on the line above it.
//
// The half it left is what the day-12 evidence calls the braid. When a label
// cell wraps onto two lines and its value cell wraps onto two of its own, the
// two columns' lines fall at slightly different heights, and reading by baseline
// interleaves them:
//
//     תקופת השכירות הראשונה ומועדי: החל מיום 1 במרץ 2026
//     תחילתה וסיומה: ועד יום 28 בפברואר 2029
//
// The dates survive and are readable -- which is why the twin could read this
// clause at all -- and the label's sentence is cut in half with a value pushed
// through the middle of it. It is the clause 13.1 reads, so it is worth a second
// pass.
//
// The fix is to stop treating a baseline as a line on such a page: find the
// corridor between the columns, assemble each column into *cells* rather than
// rows, and give each label the value cell that sits beside it.

// How far apart two runs have to be, *inside a line*, to be a label and a value
// rather than two words. `joinRow`'s measure, and only `joinRow`'s: slice 14.1d
// took it out of the page split, because on the real annex a corridor is 11pt
// and 17 of every 100 word gaps on that page are wider than that. What it used
// to hold -- that a page cannot be two columns for one caller and one column for
// the other -- `splitColumns` now holds structurally: once a page is split, no
// baseline reaches `joinRow` carrying items from both columns, so there is no
// corridor for the two of them to disagree about.
function columnGapOf(pageWidth: number): number {
  return Math.max(pageWidth * 0.06, 30);
}

// What makes a column a column, rather than the margin a clause number sits in.
//
// Measured over the whole 38-page contract (slice 14.1d, and the numbers are in
// tasks/evidence/day-14-columns.md). Every page of the body has a corridor that
// passes every other test -- 14.6pt wide with not one row crossing it, holding
// all the way down the page -- and it is the numbering margin: a column 8 to
// 14pt wide with 4 to 30 characters in it. The annex's columns are 109pt and
// 261pt wide with 101 and 543 characters.
//
// The character floor is the one that decides, and it is set at 60 rather than
// in the middle of that gap because of the page these two constants were nearly
// wrong about: one body page carries a margin 65pt wide holding 45 characters,
// which the width test admits. Read as a table it merged nine sub-clauses into
// one chunk cited by their parent -- the failure this slice exists to remove,
// arriving from the other direction.
const minColumnSpan = 0.1;
const minColumnChars = 60;

// A corridor narrower than this is two runs that nearly touch. It is a floor and
// not a signal: the deciding is done by the two constants above and by the rows
// that cross, because width is what 14.1b asked for and what did not generalise.
const minCorridor = 4;

// A heading or a line of prose legitimately lies across the corridor -- `נספח א׳`
// opens with its own title and closes with a paragraph. Two of them, counted in
// *rows*: 14.1b counted crossing text runs and allowed a quarter of the page's,
// which on a body page is dozens of lines of prose lying across the "corridor"
// it then accepted.
const maxCrossingRows = 2;

interface ColumnSplit {
  /** The column a reader reads first: the right one, in a Hebrew document. */
  labels: PdfTextItem[];
  values: PdfTextItem[];
  /** Lines that cross the corridor -- a heading, a paragraph of prose. */
  spanning: PdfTextItem[];
  /** Median glyph height: the unit a blank line is measured in. */
  typical: number;
}

// Whether this page is a two-column table, and where the corridor is.
//
// Deliberately hard to satisfy, and 14.1d changed *what* is hard about it. A
// page of prose that happens to carry one wide gap must not be re-read as a
// table -- but neither may a page whose corridor is narrower than a word gap be
// read as prose, which is what the real `נספח א׳` was. So the question is no
// longer how wide the corridor is: it is whether the corridor holds down the
// page, and whether what stands on either side of it is a column at all.
// Anything else -- three columns, a ragged layout, one column and a numbering
// margin -- returns null and the page is read exactly as it was before this
// existed.
function splitColumns(page: PdfPage): ColumnSplit | null {
  const items = page.items.filter((item) => item.text.trim().length > 0);
  if (items.length < 6) {
    return null;
  }
  const rows = groupByBaseline(items);

  let best: ColumnSplit | null = null;
  let widest = 0;
  for (const candidate of new Set(items.map((item) => item.x))) {
    const left: PdfTextItem[] = [];
    const right: PdfTextItem[] = [];
    const spanning: PdfTextItem[] = [];
    for (const item of items) {
      if (item.x + item.width <= candidate) {
        left.push(item);
      } else if (item.x >= candidate) {
        right.push(item);
      } else {
        spanning.push(item);
      }
    }
    if (left.length < 3 || right.length < 3) {
      continue;
    }
    // Persistence, and it is measured in rows on purpose: one line of prose
    // lying across the corridor is a page of prose, however few runs it is made
    // of.
    const crossingRows = rows.filter((row) =>
      row.some((item) => item.x < candidate && item.x + item.width > candidate),
    ).length;
    if (crossingRows > maxCrossingRows) {
      continue;
    }
    const corridor =
      Math.min(...right.map((item) => item.x)) -
      Math.max(...left.map((item) => item.x + item.width));
    if (corridor < minCorridor || corridor <= widest) {
      continue;
    }
    if (!isColumn(left, page.width) || !isColumn(right, page.width)) {
      continue;
    }
    widest = corridor;
    // Which side holds the labels is a question about the language, not about
    // the geometry: Hebrew reads right to left, so the right column is the one
    // a reader meets first. Decided from the content for the reason `joinRow`
    // decides it from the content -- a row of digits reports itself as ltr.
    const rightToLeft = items.some((item) => hebrew.test(item.text));
    best = {
      labels: rightToLeft ? right : left,
      values: rightToLeft ? left : right,
      spanning,
      typical: medianHeight(items),
    };
  }
  return best;
}

// Whether these items are a column of a table or the margin a clause number
// lives in. Both are vertical, both persist down the page, and only one of them
// holds text: the distinction is width and content, not position.
function isColumn(items: PdfTextItem[], pageWidth: number): boolean {
  const span =
    Math.max(...items.map((item) => item.x + item.width)) -
    Math.min(...items.map((item) => item.x));
  if (span < pageWidth * minColumnSpan) {
    return false;
  }
  const characters = items.reduce(
    (total, item) => total + item.text.trim().length,
    0,
  );
  return characters >= minColumnChars;
}

// One cell of a column: the lines of one table row, joined back into the
// sentence they were before the typesetter wrapped them.
interface Cell {
  y: number;
  text: string;
}

// A column's items, cut into cells. Lines a normal line-height apart are one
// cell that wrapped; a bigger step down the page is the next row of the table.
//
// The threshold is two glyph heights -- a blank line's worth -- rather than a
// measured line pitch, because a cell of one line gives no pitch to measure and
// the annexes are full of those.
function columnCells(
  items: PdfTextItem[],
  pageWidth: number,
  typical: number,
): Cell[] {
  const cells: Cell[] = [];
  let open: { y: number; lines: string[]; last: number } | null = null;
  for (const row of groupByBaseline(items)) {
    const text = joinRow(row, pageWidth);
    if (text.length === 0) {
      continue;
    }
    const y = Math.min(...row.map((item) => item.y));
    if (open && y - open.last <= typical * 2) {
      open.lines.push(text);
      open.last = y;
      continue;
    }
    if (open) {
      cells.push({ y: open.y, text: open.lines.join(' ') });
    }
    open = { y, lines: [text], last: y };
  }
  if (open) {
    cells.push({ y: open.y, text: open.lines.join(' ') });
  }
  return cells;
}

// The page, read as a table: every label with its own value, in the order they
// appear down the page.
function tableLines(split: ColumnSplit, pageWidth: number): string[] {
  const { typical } = split;
  const labels = columnCells(split.labels, pageWidth, typical);
  const values = columnCells(split.values, pageWidth, typical);
  const spanning = columnCells(split.spanning, pageWidth, typical);

  const bound = new Map<number, string[]>();
  const loose: Cell[] = [];
  for (const value of values) {
    // The label this value sits beside: the last one at or above it, within a
    // line's tolerance. A value with no label above it -- the top of a page
    // whose first row continues from the previous one -- is kept as its own
    // line rather than attached to whatever came next.
    const owner = labels.filter((label) => label.y <= value.y + typical).at(-1);
    if (!owner) {
      loose.push(value);
      continue;
    }
    const already = bound.get(owner.y);
    if (already) {
      already.push(value.text);
    } else {
      bound.set(owner.y, [value.text]);
    }
  }

  const lines = [
    ...labels.map((label) => ({
      y: label.y,
      text: (bound.get(label.y) ?? []).reduce(bind, label.text),
    })),
    ...loose,
    ...spanning,
  ];
  lines.sort((a, b) => a.y - b.y);
  return lines.map((line) => line.text);
}

// --- clause boundaries ----------------------------------------------------

type Draft = Omit<LeaseChunk, 'ordinal'>;

// Lines become chunks at clause boundaries: an annex heading, or a numbered
// clause. Everything before the first boundary is a chunk with a null
// reference, which is the honest description of a cover page.
function gather(lines: Line[]): Draft[] {
  const drafts: Draft[] = [];
  let annex: string | null = null;
  let open: { draft: Draft; lines: string[] } | null = null;

  const close = () => {
    if (!open) {
      return;
    }
    const text = open.lines.join('\n').trim();
    if (text.length > 0) {
      drafts.push({ ...open.draft, text });
    }
    open = null;
  };

  const start = (draft: Draft, first: string[]) => {
    close();
    open = { draft, lines: first };
  };

  let previousLine: string | null = null;
  for (const line of lines) {
    // Captured and advanced once per line, before any branch can `continue`
    // past it -- otherwise the check below reads a stale neighbour.
    const previous = previousLine;
    previousLine = line.text;
    const annexMatch = annexHeading.exec(line.text);
    if (annexMatch) {
      annex = `נספח ${annexMatch[1]}`;
      start(
        {
          clauseRef: annex,
          heading: line.text,
          text: '',
          pageFrom: line.page,
          pageTo: line.page,
        },
        [line.text],
      );
      continue;
    }
    // The two forms are guarded differently, and deliberately. A bare leading
    // number is ambiguous -- a wrapped sentence can start with one -- so it has
    // to earn the reading. `סעיף 5 – …` cannot: the word leads, a number is
    // required after it, and the whole thing is anchored to the line start, so
    // there is nothing for a continuation to be confused with.
    const bareNumber = clauseNumber.exec(line.text);
    const numberMatch = bareNumber
      ? startsClause(line.text, previous)
        ? bareNumber
        : null
      : clauseWord.exec(line.text);
    if (numberMatch) {
      start(
        {
          clauseRef: `${annex ? `${annex} ` : ''}§${numberMatch[1]}`,
          heading: null,
          text: '',
          pageFrom: line.page,
          pageTo: line.page,
        },
        [line.text],
      );
      continue;
    }
    if (!open) {
      open = {
        draft: {
          clauseRef: null,
          heading: null,
          text: '',
          pageFrom: line.page,
          pageTo: line.page,
        },
        lines: [],
      };
    }
    open.lines.push(line.text);
    // A clause that runs across a page break stays one chunk and carries two
    // page numbers, because that is where a human will look for it.
    open.draft.pageTo = line.page;
  }
  close();
  return drafts;
}

// Whether a numbered line begins a clause or merely continues the line above it.
//
// Measured on the real lease, where reading every leading number as a clause
// invented two: `§18` out of "...ועל כן יחולו הוראות סעיף / 18 להלן.", and
// `נספח י״ב §43` out of the parcel numbers "גוש 80031 חלקה / 43 ו-46 המצויים...".
// Both are a sentence wrapping onto a new visual line that happens to start with
// a digit. Both then competed for rank against real clauses as three-word
// fragments, and one of them cited a parcel as a contractual term.
//
// The test is deliberately narrow, because both signals on their own are wrong.
// A separator after the number is not required -- `נספח י״א §2.2.4` is a real
// clause without one. A previous line ending mid-sentence is not damning either
// -- clause text wraps constantly. Only the pair is conclusive: a bare number,
// no separator, and a line above that was still in the middle of a sentence.
function startsClause(text: string, previous: string | null): boolean {
  if (numberedWithSeparator.test(text)) {
    return true;
  }
  if (previous === null) {
    return true;
  }
  return endsSentence.test(previous);
}

// --- sizing ---------------------------------------------------------------

// Adjacent sub-clauses of one parent, each too small to retrieve on its own,
// become one chunk whose reference is the range they cover. `§14.1–14.3` is
// still a place a reader can turn to; three chunks of nine words each are not
// something retrieval can rank.
function coalesce(drafts: Draft[]): Draft[] {
  const merged: Draft[] = [];
  for (const draft of drafts) {
    const previous = merged.at(-1);
    // A bare parent heading folds into its first sub-clause. `§6` on its own is
    // the line "6. מטרת השכירות וייחודה" and nothing else -- measured on the
    // real lease, where it came seventh for a question about rent purely on the
    // word it shares with the question. A heading is a label for the clause
    // below it, not a clause, and retrieval that can return one is retrieval
    // that can answer a question with a table of contents.
    //
    // The reference becomes the child's, because that is where the text is; the
    // heading is kept in `heading`, where a caller can show it for context
    // without citing it.
    if (
      previous &&
      previous.text.length < minChunkChars &&
      previous.text.length + draft.text.length + 1 <= maxChunkChars &&
      isParentOf(previous.clauseRef, draft.clauseRef)
    ) {
      merged[merged.length - 1] = {
        ...draft,
        heading: previous.heading ?? previous.text,
        text: `${previous.text}\n${draft.text}`,
        pageFrom: previous.pageFrom,
      };
      continue;
    }
    if (
      previous &&
      previous.text.length < minChunkChars &&
      previous.text.length + draft.text.length + 1 <= maxChunkChars &&
      sameParent(previous.clauseRef, draft.clauseRef)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        clauseRef: rangeRef(previous.clauseRef, draft.clauseRef),
        text: `${previous.text}\n${draft.text}`,
        pageTo: draft.pageTo,
      };
      continue;
    }
    merged.push(draft);
  }
  return merged;
}

// Sub-clauses of one parent: `§14.1` and `§14.2`, or `נספח א׳ §3.1` and
// `נספח א׳ §3.2`. A top-level clause is nobody's sibling -- merging `§14` into
// `§13` would produce a reference naming two unrelated clauses, and an annex
// boundary is never crossed at all.
function sameParent(a: string | null, b: string | null): boolean {
  const left = parseRef(a);
  const right = parseRef(b);
  if (!left || !right || left.annex !== right.annex) {
    return false;
  }
  return (
    left.parts.length > 1 &&
    right.parts.length > 1 &&
    left.parts.slice(0, -1).join('.') === right.parts.slice(0, -1).join('.')
  );
}

// `§5` is the parent of `§5.1`, and of the range `§5.1–5.2`. A top-level number
// is nobody's parent across an annex boundary, and nothing is its own parent.
function isParentOf(parent: string | null, child: string | null): boolean {
  const above = parseRef(parent);
  const below = parseRef(child);
  if (!above || !below || above.annex !== below.annex) {
    return false;
  }
  const parentParts = above.end.split('.');
  const childParts = below.start.split('.');
  if (parentParts.length >= childParts.length) {
    return false;
  }
  return parentParts.every((part, at) => part === childParts[at]);
}

function rangeRef(a: string | null, b: string | null): string | null {
  const left = parseRef(a);
  const right = parseRef(b);
  if (!left || !right) {
    return a;
  }
  // From where the first one started to where the last one ends, so a chunk
  // merged three times reads `§7.1–7.3` rather than growing a chain.
  return `${left.annex}§${left.start}–${right.end}`;
}

function parseRef(
  ref: string | null,
): { annex: string; start: string; end: string; parts: string[] } | null {
  if (!ref) {
    return null;
  }
  const match = /^(.*?)§(\d+(?:\.\d+)*)(?:–(\d+(?:\.\d+)*))?$/.exec(ref);
  if (!match) {
    return null;
  }
  const start = match[2] as string;
  const end = match[3] ?? start;
  return {
    annex: match[1] ?? '',
    start,
    end,
    // The end of a range is what a further merge is measured against: a chunk
    // already covering §7.1–7.2 is a sibling of §7.3.
    parts: end.split('.'),
  };
}

// A clause longer than the cap is cut on its own line boundaries, and every
// part says which part it is. Length decides where a chunk ends; it never
// decides what a chunk is *called*, so a citation still names the clause the
// text came from.
function split(drafts: Draft[]): Draft[] {
  const out: Draft[] = [];
  for (const draft of drafts) {
    if (draft.text.length <= maxChunkChars) {
      out.push(draft);
      continue;
    }
    const parts = cut(draft.text);
    parts.forEach((text, index) => {
      out.push({
        ...draft,
        clauseRef: draft.clauseRef
          ? `${draft.clauseRef} (${index + 1}/${parts.length})`
          : null,
        heading: index === 0 ? draft.heading : null,
        text,
      });
    });
  }
  return out;
}

function cut(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (
      current.length > 0 &&
      current.length + line.length + 1 > maxChunkChars
    ) {
      parts.push(current);
      current = line;
    } else {
      current = current.length > 0 ? `${current}\n${line}` : line;
    }
    // A single line longer than the cap has no boundary to cut on. It is cut
    // anyway rather than stored over it: a chunk that cannot be embedded is a
    // clause that cannot be retrieved.
    while (current.length > maxChunkChars) {
      parts.push(current.slice(0, maxChunkChars));
      current = current.slice(maxChunkChars);
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}
