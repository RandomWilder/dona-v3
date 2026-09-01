// A policy document, cut into the sections a citation can name. Its own unit,
// pure: no clock, no pool, no store and no network -- as `occupancy`'s
// `clauses.ts` is, and for the same reason. A test can state a markdown file and
// assert what came out.
//
// This is the other front door onto one retrieval pipeline. A lease arrives as a
// PDF whose structure has to be *recovered* from geometry; a policy arrives as
// markdown **we wrote**, whose structure is already declared. So this file is a
// tenth the size of `clauses.ts` and has no heuristics in it at all -- the
// difference is not that policy is easier, it is that we own the source.

export interface GuidanceChunk {
  ordinal: number;
  // What a citation says: `נוהל פנייה למשרד § שעות פעילות`. Never null, unlike a
  // clause reference: a real lease has a cover page carrying no clause number,
  // and a file we author has no such thing. Text above the first heading is
  // cited by the document's own title.
  headingRef: string;
  // The section's heading on its own, or null for the text above the first one.
  heading: string | null;
  text: string;
}

export interface GuidanceDocument {
  title: string;
  chunks: GuidanceChunk[];
}

// Sizing, in characters. A chunk is one section first and a length second.
// Matched to `occupancy`'s `maxChunkChars` on purpose: both corpora are embedded
// by the same model and ranked against each other by `channel`, and two
// different chunk sizes would make that comparison partly a comparison of
// chunk length.
export const maxSectionChars = 1500;

const titleLine = /^#\s+(.+?)\s*$/;
const sectionLine = /^##\s+(.+?)\s*$/;

/**
 * One markdown policy document, cut on its `##` headings.
 *
 * `#` is the document's title and never a section. `###` and below are left
 * inside their section: they subdivide a topic rather than change it, and a
 * citation naming the `##` is the one a reader can find on the page.
 */
export function chunkGuidance(markdown: string): GuidanceDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');

  let title = '';
  let heading: string | null = null;
  let buffer: string[] = [];
  const sections: { heading: string | null; text: string }[] = [];

  const close = () => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      sections.push({ heading, text });
    }
    buffer = [];
  };

  for (const line of lines) {
    const isTitle = titleLine.exec(line);
    // The first `#` is the title. A second one is a document written wrong, and
    // it is treated as prose rather than silently replacing the title -- a
    // renamed document would otherwise change every citation in it.
    if (isTitle && title.length === 0) {
      title = isTitle[1] as string;
      continue;
    }
    const isSection = sectionLine.exec(line);
    if (isSection) {
      close();
      heading = isSection[1] as string;
      continue;
    }
    buffer.push(line);
  }
  close();

  if (title.length === 0) {
    // A document with no title has no way to spell a citation, and a citation
    // that names a file path is not something a tenant can check. Louder than a
    // default title, which would be one more thing nobody notices is wrong.
    throw new Error('a guidance document must open with a `# title` line');
  }

  const chunks: GuidanceChunk[] = [];
  for (const section of sections) {
    const ref =
      section.heading === null ? title : `${title} § ${section.heading}`;
    for (const text of split(section.text)) {
      chunks.push({
        ordinal: chunks.length,
        headingRef: ref,
        heading: section.heading,
        text,
      });
    }
  }
  return { title, chunks };
}

// A section longer than the cap is cut on blank lines, and every part keeps the
// section's reference. Length decides where a chunk ends; it never decides what
// a chunk is called -- `clauses.ts`'s rule, and the reason a citation still
// points at a place a reader can turn to.
function split(text: string): string[] {
  if (text.length <= maxSectionChars) {
    return [text];
  }
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    if (
      current.length > 0 &&
      current.length + paragraph.length + 2 > maxSectionChars
    ) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    }
    while (current.length > maxSectionChars) {
      parts.push(current.slice(0, maxSectionChars));
      current = current.slice(maxSectionChars);
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}
