import { KernelError } from '../../kernel/errors.ts';

// Phone normalisation is pure on purpose: no clock, no pool, no database. It is
// the one piece of this module that the day-8 importer will run over thousands
// of rows, and the one whose failure duplicates people. See SPEC-identity.md.

const israelCode = '972';

// Separators a human or a spreadsheet inserts, plus the bidi control characters
// a Hebrew form pastes in around a left-to-right number.
const noise = /[\s.()\u200e\u200f\u202a-\u202e-]/gu;

// National number length by leading digit: mobile and VoIP run to nine digits,
// landlines to eight. Anything else — 1XX service numbers above all — is not a
// person's number.
const israeliLengthByPrefix: Record<string, number> = {
  '2': 8,
  '3': 8,
  '4': 8,
  '5': 9,
  '7': 9,
  '8': 8,
  '9': 8,
};

function invalid(reason: string): KernelError {
  return new KernelError('invalid', 'phone number is invalid', { reason });
}

// Takes `unknown`, not `string`: every caller is an edge, and a non-string
// reaching here must become `invalid` rather than a TypeError.
export function normalizePhone(input: unknown): string {
  if (typeof input !== 'string') {
    throw invalid('not a string');
  }
  const cleaned = input.replace(noise, '');
  if (cleaned.length === 0) {
    throw invalid('empty');
  }

  // 00 is the other way of writing +, and arrives from landline habits.
  const plussed = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;

  if (plussed.startsWith('+')) {
    const digits = plussed.slice(1);
    if (!/^\d+$/.test(digits)) {
      throw invalid('not digits');
    }
    return digits.startsWith(israelCode)
      ? israeli(digits.slice(israelCode.length))
      : international(digits);
  }

  if (!/^\d+$/.test(plussed)) {
    throw invalid('not digits');
  }
  if (plussed.startsWith(israelCode)) {
    return israeli(plussed.slice(israelCode.length));
  }
  if (plussed.startsWith('0')) {
    return israeli(plussed.slice(1));
  }
  // A bare national number with neither a leading 0 nor a country code could be
  // anything. Refusing beats guessing: a guess here becomes a second person.
  throw invalid('no country code and no leading zero');
}

// The national number is what follows +972 — never a leading 0.
function israeli(national: string): string {
  const expected = israeliLengthByPrefix[national[0] ?? ''];
  if (expected === undefined) {
    throw invalid('not an Israeli subscriber prefix');
  }
  if (national.length !== expected) {
    throw invalid('wrong length for an Israeli number');
  }
  return `+${israelCode}${national}`;
}

// Everything outside Israel is only ever accepted when the caller wrote it
// explicitly, so the check is E.164's own: 8 to 15 digits, no leading zero.
function international(digits: string): string {
  if (digits.startsWith('0')) {
    throw invalid('country code cannot start with zero');
  }
  if (digits.length < 8 || digits.length > 15) {
    throw invalid('not an E.164 length');
  }
  return `+${digits}`;
}
