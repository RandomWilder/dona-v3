import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from './errors.ts';
import { newId } from './ids.ts';
import { asText, optionalText, requireText, validId } from './validate.ts';

const invalid = (error: KernelError) => error.code === 'invalid';

describe('kernel edge validation', () => {
  describe('requireText', () => {
    it('trims and returns', () => {
      assert.equal(requireText('  הרצל  ', 'street', 200), 'הרצל');
    });

    it('measures after trimming, not before', () => {
      // 200 characters plus surrounding space is 200 characters.
      const padded = ` ${'a'.repeat(200)} `;
      assert.equal(requireText(padded, 'name', 200).length, 200);
      assert.throws(() => requireText('a'.repeat(201), 'name', 200), invalid);
    });

    it('refuses whitespace as if it were empty', () => {
      assert.throws(() => requireText('   ', 'name', 200), invalid);
      assert.throws(() => requireText('', 'name', 200), invalid);
    });

    it('refuses anything that is not a string', () => {
      for (const value of [undefined, null, 7, {}, [], true]) {
        assert.throws(() => requireText(value, 'name', 200), invalid);
      }
    });

    it('names the field in the message', () => {
      assert.throws(() => requireText(undefined, 'houseNumber', 50), {
        message: 'houseNumber is required',
      });
      assert.throws(() => requireText('', 'houseNumber', 50), {
        message: 'houseNumber must be 1 to 50 characters',
      });
    });
  });

  describe('optionalText', () => {
    it('lets absence through as null', () => {
      assert.equal(optionalText(undefined, 'notes', 2000), null);
      assert.equal(optionalText(null, 'notes', 2000), null);
    });

    it('holds a present value to requireText s rules', () => {
      assert.equal(optionalText('  קוד  ', 'notes', 2000), 'קוד');
      assert.throws(() => optionalText('  ', 'notes', 2000), invalid);
      assert.throws(() => optionalText(7, 'notes', 2000), invalid);
    });
  });

  describe('validId', () => {
    it('accepts a minted id', () => {
      const id = newId();
      assert.equal(validId(id, 'personId'), id);
    });

    it('accepts either case', () => {
      const id = newId().toUpperCase();
      assert.equal(validId(id, 'personId'), id);
    });

    it('refuses anything that is not one', () => {
      for (const value of [
        'not-an-id',
        '',
        undefined,
        null,
        42,
        // A uuid with a character out of range, and one a group too short.
        'g1234567-1234-1234-1234-123456789abc',
        '11234567-1234-1234-1234-123456789ab',
      ]) {
        assert.throws(() => validId(value, 'unitId'), invalid);
      }
    });

    it('names the field in the message', () => {
      assert.throws(() => validId('nope', 'buildingId'), {
        message: 'buildingId is not an id',
      });
    });
  });

  describe('asText', () => {
    // Audit entries are built before validation runs, so this must never throw.
    it('passes strings through and everything else to undefined', () => {
      assert.equal(asText('050-1234567'), '050-1234567');
      assert.equal(asText(''), '');
      for (const value of [undefined, null, 7, {}, []]) {
        assert.equal(asText(value), undefined);
      }
    });
  });
});
