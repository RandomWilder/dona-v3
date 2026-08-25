import { createRequire } from 'node:module';
import path from 'node:path';
import { KernelError } from './errors.ts';

// PDF text, on the same footing as objects.ts: the shape of a document and no
// business logic at all. It does not know what a lease or a clause is -- the
// module that does turns these items into chunks (SPEC-occupancy.md).
//
// Positions and not a string, deliberately. A reader that hands back a page as
// one paragraph is unusable for the document this system exists to read: the
// lease's facts live in a two-column label/value annex, and flattened text
// binds every value to the label on the line above it
// (docs/reference/lease-template-donadom.md). Positions are also what makes a
// citation traceable to a place rather than merely attributed to a document.

export interface PdfTextItem {
  text: string;
  // Top-down page coordinates, not PDF's bottom-up ones: y grows downward, so
  // reading order is ascending y and a caller never has to remember which way
  // up the page is. x is the item's left edge and `width` its advance, so its
  // right edge is x + width -- the edge a right-to-left line starts at.
  x: number;
  y: number;
  width: number;
  height: number;
  // What the extractor believed about direction. Hebrew arrives as `rtl` with
  // `text` already in logical order.
  rightToLeft: boolean;
  endsLine: boolean;
}

export interface PdfPage {
  // 1-based, and it is the number a citation shows a human.
  number: number;
  width: number;
  height: number;
  // Empty for a page with no text layer. That is not an error: four pages of
  // the sample lease are images, and saying *which* is the caller's job
  // (ROADMAP week 3's OCR cut line).
  items: PdfTextItem[];
}

export interface PdfText {
  pages(bytes: Buffer): Promise<PdfPage[]>;
  // For the boot line and for tests, as ObjectStore.describe() is.
  describe(): string;
}

// pdfjs's own item shape, narrowed to what is used. A text content stream also
// carries marked-content markers with no `str` at all, which is why every item
// is checked rather than cast.
interface PdfjsItem {
  str?: unknown;
  dir?: unknown;
  width?: unknown;
  height?: unknown;
  transform?: unknown;
  hasEOL?: unknown;
}

// The standard-font data ships inside the package. Resolved from the package's
// own location rather than a path relative to this file, so it survives being
// hoisted or nested by npm; without it pdfjs warns on every document that uses
// a base-14 font.
function standardFontDataUrl(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pdfjs-dist/package.json');
  return `${path.join(path.dirname(pkg), 'standard_fonts')}${path.sep}`;
}

export function createPdfjsText(): PdfText {
  return {
    async pages(bytes) {
      // Lazily, and once per call: a process that never reads a PDF never pays
      // for loading it, exactly as objects.ts defers reading ADC.
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({
        // A copy, because pdfjs transfers the buffer it is given and the caller
        // still holds these bytes -- they are on their way into a row.
        data: new Uint8Array(bytes),
        // The input is a third-party PDF, and a PDF is a program. Nothing here
        // renders, so nothing here needs a glyph: no system fonts, no font
        // faces built at runtime. (pdfjs's old `isEvalSupported` switch is
        // gone in v6 -- eval-based font compilation was removed outright, so
        // there is no longer a lever to turn off.)
        useSystemFonts: false,
        disableFontFace: true,
        standardFontDataUrl: standardFontDataUrl(),
      });
      let document: Awaited<typeof task.promise>;
      try {
        document = await task.promise;
      } catch (cause) {
        // An unopenable file is `invalid` and never a driver stack: the caller
        // is a staff screen, and the sentence it shows should be about the
        // file rather than about pdfjs.
        await task.destroy().catch(() => {});
        throw new KernelError(
          'invalid',
          'the file could not be read as a PDF',
          {
            reason: cause instanceof Error ? cause.message : 'unknown',
          },
        );
      }
      try {
        const pages: PdfPage[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const page = await document.getPage(number);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          pages.push({
            number,
            width: viewport.width,
            height: viewport.height,
            items: readItems(content.items as PdfjsItem[], viewport.height),
          });
        }
        return pages;
      } finally {
        await task.destroy().catch(() => {});
      }
    },
    describe: () => 'pdfjs',
  };
}

function readItems(items: PdfjsItem[], pageHeight: number): PdfTextItem[] {
  const read: PdfTextItem[] = [];
  for (const item of items) {
    if (typeof item?.str !== 'string' || !Array.isArray(item.transform)) {
      // A marked-content marker rather than text.
      continue;
    }
    const transform = item.transform as number[];
    const x = Number(transform[4]);
    const baseline = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(baseline)) {
      continue;
    }
    const endsLine = item.hasEOL === true;
    if (item.str.trim().length === 0) {
      // pdfjs emits an empty run to carry a line break. It is the *previous*
      // item's line that ends, and dropping the run while keeping the fact is
      // what stops every such break becoming a blank chunk downstream.
      const previous = read.at(-1);
      if (endsLine && previous) {
        previous.endsLine = true;
      }
      continue;
    }
    read.push({
      text: item.str,
      x,
      // PDF's origin is the bottom-left corner. Flipped here, once, so that
      // every reader downstream can sort by y and get reading order.
      y: pageHeight - baseline,
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      rightToLeft: item.dir === 'rtl',
      endsLine,
    });
  }
  return read;
}
