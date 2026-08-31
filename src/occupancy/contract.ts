// The occupancy module's public surface. Nothing outside this module reaches
// past this file — internals live under `internal/`. See SPEC-occupancy.md.

export type { LeaseChunk } from './internal/clauses.ts';
export { maxChunkChars } from './internal/clauses.ts';
// Promoted in slice 8.1, for the same reason normalizePhone was: the importer
// must reject a bad date before it writes, and a second copy of the rule would
// drift from the one the commands enforce.
export { optionalDate, validDate } from './internal/dates.ts';
export type {
  AttachDocumentInput,
  ChunkRecord,
  ClauseHit,
  DocumentKind,
  DocumentRecord,
  Extraction,
  ExtractTwinInput,
  IngestDocumentInput,
  Ingestion,
  LeaseFact,
  LeaseFieldReview,
  ReviewLeaseFieldInput,
  SearchClausesInput,
} from './internal/documents.ts';
export {
  defaultSearchLimit,
  documentContentType,
  documentKinds,
  maxDocumentBytes,
  maxSearchLimit,
} from './internal/documents.ts';
// Slice 13.2. The correction form is generated from the stored value, and the
// rule about which parts of one a human may touch is a fact about a lease field
// rather than about HTML -- so the screen asks this module rather than deciding
// for itself. `applyEdits` is deliberately *not* exported: the edits are applied
// inside the command, to the value it read, and never by a caller.
export type { EditableGroup, EditableLeaf } from './internal/edits.ts';
export { editableGroups } from './internal/edits.ts';
export type { OccupancyRole, TenancyAccess } from './internal/roles.ts';
export { occupancyRoles, tenancyAccess } from './internal/roles.ts';
export type {
  Actor,
  AddPartyInput,
  EndTenancyInput,
  Occupancy,
  OccupancyDeps,
  OccupancyResolution,
  OpenTenancyInput,
  Party,
  ResolvedTenancy,
  Tenancy,
  TenancyParty,
  TenancyView,
} from './internal/tenancies.ts';
export { createOccupancy } from './internal/tenancies.ts';
// Slice 13.1. The vocabulary of the twin, exported because a screen renders one
// field per entry and 13.2 confirms them one at a time -- the registry's own
// order is the order both read in.
export type {
  Confidence,
  LeaseField,
  ReviewDecision,
} from './internal/twin.ts';
export { leaseFields, reviewDecisions } from './internal/twin.ts';
