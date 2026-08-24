import { KernelError } from '../../kernel/errors.ts';

// Pure. A lease term is a run of Israeli calendar dates, not a run of instants,
// so these are `YYYY-MM-DD` strings all the way to the `date` columns.

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;

// `new Date('2026-02-30')` is March 2nd, silently. A lease date that means
// something other than what it says is the kind of thing that only surfaces as
// a tenant being told the wrong thing, so the round trip is checked rather
// than assumed.
export function validDate(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new KernelError('invalid', `${field} is required`);
  }
  const match = isoDate.exec(value.trim());
  if (!match) {
    throw new KernelError('invalid', `${field} must be YYYY-MM-DD`);
  }
  const [, year, month, day] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new KernelError('invalid', `${field} is not a date`);
  }
  return `${year}-${month}-${day}`;
}

export function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validDate(value, field);
}
