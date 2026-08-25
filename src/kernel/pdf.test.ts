import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from './errors.ts';
import { createPdfjsText } from './pdf.ts';
import { type SampleRun, samplePdf } from './pdf-sample.ts';

// The adapter is exercised against a PDF built by `samplePdf`, byte by byte,
// rather than against a committed sample: the only real lease this project has
// is a signed contract that must never enter the repo (tasks/fuses.md), and a
// document written by the test can state its own coordinates -- which is the
// property being asserted. The Hebrew document is proved on staging by the
// slice's verify step, where the real one is.

// One text run at a known point on a 595x842 page, in PDF's own bottom-up
// coordinates -- so the flip the adapter performs is visible in the assertion.
function textAt(x: number, bottomUpY: number, text: string): SampleRun {
  return { x, y: bottomUpY, text };
}

describe('pdf text', () => {
  it('reads every page, with each item positioned top-down', async () => {
    const pdf = createPdfjsText();
    const pages = await pdf.pages(
      samplePdf([
        [textAt(400, 700, 'Rent'), textAt(120, 700, '4200')],
        [textAt(400, 660, 'Clause 1.')],
      ]),
    );

    assert.equal(pages.length, 2);
    assert.equal(pages[0]?.number, 1);
    assert.equal(pages[0]?.width, 595);
    assert.equal(pages[0]?.height, 842);

    const first = pages[0]?.items ?? [];
    assert.deepEqual(
      first.map((item) => item.text),
      ['Rent', '4200'],
    );
    // PDF puts the origin at the bottom-left. The adapter flips it once, here,
    // so that every reader downstream sorts by y and gets reading order.
    assert.equal(first[0]?.y, 842 - 700);
    assert.equal(first[0]?.x, 400);
    assert.equal(first[1]?.x, 120);
    // Both runs sit on one baseline: this is the shape a two-column
    // label/value row arrives in, and the reason positions are kept at all.
    assert.equal(first[0]?.y, first[1]?.y);
    assert.ok((first[0]?.width ?? 0) > 0);

    assert.equal(pages[1]?.items[0]?.text, 'Clause 1.');
    assert.equal(pages[1]?.number, 2);
  });

  it('reports a page with no text layer as empty rather than as an error', async () => {
    // Four pages of the sample lease are images (the floor plan, a spec cover,
    // a placeholder and one page of tables). Ingestion has to be able to say
    // which pages those were -- ROADMAP week 3's OCR cut line -- and it cannot
    // if the reader throws on the first one.
    // The second page is not blank -- `samplePdf` gives a page with no runs a
    // grey rectangle, which is what a scan or a floor plan looks like to a
    // reader: content, carrying no text layer.
    const pages = await createPdfjsText().pages(
      samplePdf([[textAt(100, 700, 'Page one')], []]),
    );
    assert.equal(pages.length, 2);
    assert.equal(pages[1]?.items.length, 0);
  });

  it('calls a file it cannot open invalid, not a driver stack', async () => {
    const error = await createPdfjsText()
      .pages(Buffer.from('this is not a pdf'))
      .then(
        () => null,
        (thrown: KernelError) => thrown,
      );
    assert.equal(error?.code, 'invalid');
    assert.match(error?.message ?? '', /PDF/);
  });

  it('says which reader is running', () => {
    assert.equal(createPdfjsText().describe(), 'pdfjs');
  });
});
