import { KernelError } from '../../kernel/errors.ts';
import type { DocumentKind } from './documents.ts';

// Where a document lives in the bucket. Its own unit, pure: no clock, no pool,
// no database -- as roles.ts and dates.ts are.
//
// Slice 7.0's rule is that a path carries the place and never the people,
// because paths reach logs, error messages and audit rows. 7.0 wrote that rule
// as a readable address, transliterated by hand for the one document uploaded
// by hand. Generating that shape means transliterating Hebrew in code, and two
// streets that transliterate alike would file one flat's lease under another's
// -- a correctness failure with isolation flavour, arriving quietly. Ids also
// do not rot: correcting a building's address leaves every object still
// correctly filed, and objects cannot be cheaply renamed.
//
// So the path is ids, and the row is the index from an address to an object.

const idShape = /^[0-9a-f-]{36}$/i;

export function documentPath(parts: {
  buildingId: string;
  unitId: string;
  tenancyId: string;
  documentId: string;
  kind: DocumentKind;
}): string {
  // Every segment is an id this system minted, and the assertion is here rather
  // than assumed: a caller that passed a display name would put a person's name
  // in a path, which is the one thing this function exists to prevent.
  for (const [name, value] of Object.entries(parts)) {
    if (name === 'kind') {
      continue;
    }
    if (!idShape.test(value)) {
      throw new KernelError('invalid', `${name} is not an id`);
    }
  }
  return [
    'leases',
    `bldg-${parts.buildingId}`,
    `unit-${parts.unitId}`,
    `tenancy-${parts.tenancyId}`,
    `${parts.kind}-${parts.documentId}.pdf`,
  ].join('/');
}
