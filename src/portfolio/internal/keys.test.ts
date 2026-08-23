import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import { addressKey, unitKey } from './keys.ts';

const herzl = { city: 'תל אביב', street: 'הרצל', houseNumber: '12' };

describe('address keys', () => {
  // Every one of these is a way the same building arrives twice in a property
  // list, and would otherwise become two buildings with its units split.
  it('collapses spacing and case to one key', () => {
    const spellings = [
      herzl,
      { city: '  תל אביב  ', street: 'הרצל', houseNumber: '12' },
      { city: 'תל  אביב', street: ' הרצל ', houseNumber: ' 12' },
      { city: 'תל אביב', street: 'הרצל', houseNumber: '12 ' },
    ];
    const keys = new Set(spellings.map(addressKey));
    assert.equal(keys.size, 1);
  });

  it('lowercases Latin street names', () => {
    assert.equal(
      addressKey({ city: 'Tel Aviv', street: 'Herzl', houseNumber: '12' }),
      addressKey({ city: 'tel aviv', street: 'HERZL', houseNumber: '12' }),
    );
  });

  // The other half of the job: keys that must NOT collide.
  it('keeps genuinely different addresses apart', () => {
    const distinct = [
      herzl,
      { ...herzl, houseNumber: '12א' },
      { ...herzl, houseNumber: '13' },
      { ...herzl, street: 'הרצל שלום' },
      { ...herzl, city: 'חיפה' },
    ];
    assert.equal(new Set(distinct.map(addressKey)).size, distinct.length);
  });

  // It does not know that רח׳ is רחוב, and must not pretend to.
  it('does not guess at street-word abbreviations', () => {
    assert.notEqual(
      addressKey({ ...herzl, street: "רח' הרצל" }),
      addressKey({ ...herzl, street: 'רחוב הרצל' }),
    );
  });

  for (const missing of [
    { ...herzl, city: '' },
    { ...herzl, street: '   ' },
    { ...herzl, houseNumber: '' },
  ]) {
    it(`rejects an incomplete address ${JSON.stringify(missing)}`, () => {
      assert.throws(
        () => addressKey(missing),
        (error: KernelError) => error.code === 'invalid',
      );
    });
  }
});

describe('unit keys', () => {
  it('treats a padded number as the same apartment', () => {
    const keys = new Set(['3', '03', ' 003 ', '3 '].map(unitKey));
    assert.deepEqual([...keys], ['3']);
  });

  it('keeps a bare zero rather than emptying it', () => {
    assert.equal(unitKey('0'), '0');
    assert.equal(unitKey('00'), '0');
  });

  it('leaves a non-numeric label alone beyond spacing and case', () => {
    assert.equal(unitKey(' 12א '), '12א');
    assert.equal(unitKey('Penthouse'), 'penthouse');
    // Not a number, so its leading zero is part of the name.
    assert.equal(unitKey('0א'), '0א');
  });

  it('keeps different apartments apart', () => {
    const distinct = ['3', '12', '12א', 'ב', 'penthouse'];
    assert.equal(new Set(distinct.map(unitKey)).size, distinct.length);
  });

  it('rejects an empty label', () => {
    assert.throws(
      () => unitKey('   '),
      (error: KernelError) => error.code === 'invalid',
    );
  });
});
