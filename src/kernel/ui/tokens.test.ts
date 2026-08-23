import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const srcRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const shells = [
  path.join(srcRoot, 'staff/ui/index.html'),
  path.join(srcRoot, 'channel/ui/index.html'),
];

// The discipline erodes in the screens, not in the stylesheet — so the guard
// runs against the HTML.
describe('shared UI tokens', () => {
  it('is the only place a colour, a face, or a physical side is named', async () => {
    for (const file of shells) {
      const html = await readFile(file, 'utf8');
      assert.doesNotMatch(html, /fonts\.googleapis/, file);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/, file);
      assert.doesNotMatch(html, /(?:^|[\s;{])(?:left|right)\s*:/m, file);
      assert.doesNotMatch(html, /font-family\s*:/, file);
    }
  });

  it('keeps every shell Hebrew, RTL, and linked to the token layer', async () => {
    for (const file of shells) {
      const html = await readFile(file, 'utf8');
      assert.match(html, /<html lang="he" dir="rtl">/, file);
      assert.match(html, /href="\/ui\/tokens\.css"/, file);
      assert.doesNotMatch(html, /<script src=/, file);
    }
  });
});
