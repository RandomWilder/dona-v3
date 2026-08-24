import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import { optionalDate, validDate } from './dates.ts';

const invalid = (error: KernelError) => error.code === 'invalid';

describe('occupancy dates', () => {
  describe('validDate', () => {
    it('accepts an ISO calendar date and trims it', () => {
      assert.equal(validDate('2026-09-01', 'startsOn'), '2026-09-01');
      assert.equal(validDate('  2026-09-01  ', 'startsOn'), '2026-09-01');
    });

    it('accepts the leap day of a leap year', () => {
      assert.equal(validDate('2028-02-29', 'startsOn'), '2028-02-29');
    });

    // `new Date('2026-02-30')` is March 2nd, silently. A lease date meaning
    // something other than what it says surfaces only as a tenant being told
    // the wrong thing, so the round trip is checked rather than assumed.
    it('refuses a day that does not exist', () => {
      assert.throws(() => validDate('2026-02-30', 'startsOn'), invalid);
      assert.throws(() => validDate('2026-04-31', 'startsOn'), invalid);
      assert.throws(() => validDate('2026-13-01', 'startsOn'), invalid);
      assert.throws(() => validDate('2026-00-10', 'startsOn'), invalid);
      assert.throws(() => validDate('2026-02-00', 'startsOn'), invalid);
    });

    it('refuses the leap day of a common year', () => {
      assert.throws(() => validDate('2026-02-29', 'startsOn'), invalid);
    });

    it('refuses anything that is not YYYY-MM-DD', () => {
      for (const value of [
        '1.9.2026',
        '2026-9-1',
        '01/09/2026',
        '2026-09-01T00:00:00Z',
        'today',
        '',
      ]) {
        assert.throws(() => validDate(value, 'startsOn'), invalid);
      }
    });

    it('refuses anything that is not a string', () => {
      for (const value of [undefined, null, 20260901, new Date()]) {
        assert.throws(() => validDate(value, 'startsOn'), invalid);
      }
    });

    it('names the field in the message', () => {
      assert.throws(() => validDate(undefined, 'endsOn'), {
        message: 'endsOn is required',
      });
      assert.throws(() => validDate('nope', 'endsOn'), {
        message: 'endsOn must be YYYY-MM-DD',
      });
      assert.throws(() => validDate('2026-02-30', 'endsOn'), {
        message: 'endsOn is not a date',
      });
    });

    // Dates are compared as strings against `date` columns, which only works
    // because the format sorts lexicographically.
    it('yields a form that sorts as a date', () => {
      const dates = ['2026-10-01', '2026-09-30', '2027-01-01', '2026-09-02'];
      assert.deepEqual(dates.map((d) => validDate(d, 'startsOn')).sort(), [
        '2026-09-02',
        '2026-09-30',
        '2026-10-01',
        '2027-01-01',
      ]);
    });
  });

  describe('optionalDate', () => {
    it('lets an open-ended term through as null', () => {
      assert.equal(optionalDate(undefined, 'endsOn'), null);
      assert.equal(optionalDate(null, 'endsOn'), null);
    });

    it('holds a present value to the same rules', () => {
      assert.equal(optionalDate('2027-08-31', 'endsOn'), '2027-08-31');
      assert.throws(() => optionalDate('2027-02-30', 'endsOn'), invalid);
    });
  });
});
