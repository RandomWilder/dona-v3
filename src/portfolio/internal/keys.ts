import { KernelError } from '../../kernel/errors.ts';

// Natural keys for places. Pure: no clock, no pool, no database — the same
// shape as identity's phone normalisation, and for the same reason. The day-8
// importer runs this over every row of a real property list, and two spellings
// of one address becoming two buildings splits its units in half.
//
// Deliberately naive: whitespace and case only. Nothing here knows that רח׳ and
// רחוב are the same word. See SPEC-portfolio.md — a rule invented before the
// real addresses arrive is a guess, and a wrong guess merges two buildings.

export interface AddressParts {
  city: string;
  street: string;
  houseNumber: string;
}

const digitsOnly = /^\d+$/;

function part(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function addressKey(address: AddressParts): string {
  const key = [address.city, address.street, address.houseNumber]
    .map(part)
    .join('|');
  if (key.split('|').some((piece) => piece.length === 0)) {
    throw new KernelError('invalid', 'address is incomplete');
  }
  return key;
}

// A label that is all digits loses its leading zeros, so `03` and `3` are one
// apartment. A label that is not — `12א`, `ב`, `Penthouse` — is left alone
// beyond spacing and case, because stripping anything else starts guessing.
export function unitKey(label: string): string {
  const normalized = part(label);
  if (normalized.length === 0) {
    throw new KernelError('invalid', 'unit label is required');
  }
  if (digitsOnly.test(normalized)) {
    return normalized.replace(/^0+(?=\d)/u, '');
  }
  return normalized;
}
