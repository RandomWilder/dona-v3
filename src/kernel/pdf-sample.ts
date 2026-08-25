// A PDF, built byte by byte, for tests to read back.
//
// Named to avoid node --test's `test-*` collection pattern, as pg-support.ts is:
// this is a helper, not a suite. It lives in src rather than beside one test
// file because two suites need it -- the kernel adapter's, and the staff edge's,
// which posts a document through the real upload form and then ingests it.
//
// The only real lease this project has is a signed contract that must never
// enter the repo (tasks/fuses.md), so every test PDF is written here instead.
// Latin text only: carrying Hebrew would need an embedded font and a CMap, and
// what these fixtures are for is geometry and plumbing rather than pdfjs's
// character decoding. Clause numbering is digits in either language.

export interface SampleRun {
  // PDF's own coordinates: the origin is the bottom-left corner, so a larger y
  // is higher up the page. The adapter is what flips them.
  x: number;
  y: number;
  text: string;
}

const mediaBox = '[0 0 595 842]';

export function samplePdf(pages: SampleRun[][]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageIds
      .map((id) => `${id} 0 R`)
      .join(' ')}] /Count ${pages.length} >>\nendobj\n`,
  );
  objects.push(
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  );
  pages.forEach((runs, index) => {
    const id = pageIds[index] as number;
    // A page with no runs still has content -- a grey rectangle -- because that
    // is what a scanned page or a floor plan looks like to a reader: not blank,
    // just carrying no text layer.
    const content =
      runs.length > 0
        ? runs.map(draw).join('\n')
        : '0.9 g 100 500 400 200 re f';
    objects.push(
      `${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox}` +
        ` /Resources << /Font << /F1 3 0 R >> >>` +
        ` /Contents ${id + 1} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${id + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
  });

  let file = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(file.length);
    file += object;
  }
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    file += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  file += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file, 'latin1');
}

function draw(run: SampleRun): string {
  return `BT /F1 12 Tf 1 0 0 1 ${run.x} ${run.y} Tm (${escaped(run.text)}) Tj ET`;
}

// `(`, `)` and `\` end or escape a PDF string literal. A fixture that ignored
// them would produce a file pdfjs reads as damaged, which is a confusing way
// for an unrelated test to fail.
function escaped(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}
