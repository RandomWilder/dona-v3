import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GuidanceFile, GuidanceSource } from './documents.ts';

// Where policy text comes from in this repo: markdown files under
// `docs/guidance/`, authored by us and reviewed in a pull request. The module's
// own adapter rather than a kernel port -- reading the repo's own documentation
// is not something the kernel should know how to do, and nothing else in the
// system needs it.

export const guidanceDir = fileURLToPath(
  new URL('../../../docs/guidance/', import.meta.url),
);

export function createDirectorySource(dir = guidanceDir): GuidanceSource {
  return {
    async list(): Promise<GuidanceFile[]> {
      const names = (await readdir(dir))
        .filter((name) => name.endsWith('.md'))
        .sort();
      const files: GuidanceFile[] = [];
      for (const name of names) {
        files.push({
          // The file name without its extension. Stable across a retitling, so
          // editing `# נוהל …` is an update rather than a second document.
          slug: path.basename(name, '.md'),
          path: `docs/guidance/${name}`,
          markdown: await readFile(path.join(dir, name), 'utf8'),
        });
      }
      return files;
    },
    describe: () => `docs/guidance (${path.basename(dir)})`,
  };
}
