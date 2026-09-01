// The catalog module's public surface. Nothing outside this module reaches past
// this file — internals live under `internal/`. See SPEC-catalog.md.

export type {
  Catalog,
  CatalogDeps,
  GuidanceActor,
  GuidanceFile,
  GuidanceHit,
  GuidanceRecord,
  GuidanceSource,
  GuidanceSync,
  SearchGuidanceInput,
} from './internal/documents.ts';
export {
  createCatalog,
  defaultGuidanceLimit,
  maxGuidanceLimit,
} from './internal/documents.ts';
// The chunker is exported for the reason occupancy exports `maxChunkChars`: a
// caller that renders a section, or a test that authors one, has to agree with
// the module about where a section begins.
export type { GuidanceChunk, GuidanceDocument } from './internal/guidance.ts';
export { chunkGuidance, maxSectionChars } from './internal/guidance.ts';
export { createDirectorySource, guidanceDir } from './internal/source.ts';
