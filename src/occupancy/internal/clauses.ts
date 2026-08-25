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

// `נספח א׳`, `נספח י״ב` -- one or two Hebrew letters with a geresh or
// gershayim. Anchored: the word appears inside sentences too ("as set out in
// נספח ב׳"), and only a line that *begins* with it is a heading.
const annexHeading = /^נספח\s+([א-ת]{1,2}["'׳״]?[א-ת]?)/;

// `14.`, `3.2`, `12.1.4` at the start of a line. The trailing separator is
// optional because typesetting varies between the body and the annexes.
const clauseNumber = /^(\d+(?:\.\d+)*)[.)]?(?:\s|$)/;

const hebrew = /[א-ת]/;

interface Line {
  page: number;
  text: string;
}

export function chunkLease(pages: PdfPage[]): LeaseChunking {
  const imageOnlyPages: number[] = [];
  const lines: Line[] = [];
  for (const page of pages) {
    if (page.items.length === 0) {
      imageOnlyPages.push(page.number);
      continue;
    }
    for (const text of pageLines(page)) {
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
function pageLines(page: PdfPage): string[] {
  const assembled: string[] = [];
  for (const row of groupByBaseline(page.items)) {
    const text = joinRow(row, page.width);
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
  const heights = sorted
    .map((item) => item.height)
    .filter((height) => height > 0);
  const typical = heights.length > 0 ? median(heights) : 10;
  const tolerance = Math.max(typical * 0.6, 2);

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
  const columnGap = Math.max(pageWidth * 0.06, 30);
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
    return /[:：]$/.test(label) ? `${label} ${value}` : `${label}: ${value}`;
  }
  return cleaned.join(' | ');
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
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

  for (const line of lines) {
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
    const numberMatch = clauseNumber.exec(line.text);
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

// --- sizing ---------------------------------------------------------------

// Adjacent sub-clauses of one parent, each too small to retrieve on its own,
// become one chunk whose reference is the range they cover. `§14.1–14.3` is
// still a place a reader can turn to; three chunks of nine words each are not
// something retrieval can rank.
function coalesce(drafts: Draft[]): Draft[] {
  const merged: Draft[] = [];
  for (const draft of drafts) {
    const previous = merged.at(-1);
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
