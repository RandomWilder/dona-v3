import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import { normalizePhone } from './phone.ts';

// The three formats named in the slice, plus every other spelling the pilot data
// and the WhatsApp adapter can produce. One row here is one way a tenant could
// otherwise have become two people.
const accepted: Array<[string, string]> = [
  ['050-123-4567', '+972501234567'],
  ['+972 50 123 4567', '+972501234567'],
  ['972501234567', '+972501234567'],
  ['0501234567', '+972501234567'],
  ['+972501234567', '+972501234567'],
  ['00972501234567', '+972501234567'],
  ['972-50-1234567', '+972501234567'],
  ['  050 1234567  ', '+972501234567'],
  ['(050) 123-4567', '+972501234567'],
  // A bidi mark pasted in from a Hebrew form, invisible to whoever pasted it.
  ['‏050-1234567‎', '+972501234567'],
  // Landlines are eight national digits, not nine.
  ['03-1234567', '+97231234567'],
  ['+972 3 123 4567', '+97231234567'],
  ['08-9123456', '+97289123456'],
  // VoIP numbers are nine, like mobiles.
  ['077-1234567', '+972771234567'],
  // International, written explicitly.
  ['+44 20 7946 0958', '+442079460958'],
  ['+1 (415) 555-2671', '+14155552671'],
];

const rejected: Array<[string, string]> = [
  ['', 'empty'],
  ['   ', 'empty'],
  ['050123', 'too short for an Israeli mobile'],
  ['05012345678', 'too long for an Israeli mobile'],
  ['0312345678', 'too long for an Israeli landline'],
  ['501234567', 'no leading zero and no country code'],
  ['1800123456', 'a service number, not a person'],
  ['+9721800123456', 'a service number with a country code'],
  ['0123456789', 'not a subscriber prefix'],
  ['+972012345678', 'national number cannot keep its zero'],
  ['+123', 'below E.164 length'],
  ['+1234567890123456', 'above E.164 length'],
  ['+0441234567', 'country code cannot start with zero'],
  ['050-123-456a', 'letters'],
  ['not a phone', 'words'],
];

describe('phone normalisation', () => {
  for (const [input, expected] of accepted) {
    it(`normalises ${JSON.stringify(input)}`, () => {
      assert.equal(normalizePhone(input), expected);
    });
  }

  for (const [input, why] of rejected) {
    it(`rejects ${JSON.stringify(input)} — ${why}`, () => {
      assert.throws(
        () => normalizePhone(input),
        (error: KernelError) => error.code === 'invalid',
      );
    });
  }

  // The property the whole module rests on, stated as a test rather than left
  // to the reader of the table above.
  it('collapses every spelling of one number to one string', () => {
    const spellings = [
      '050-123-4567',
      '+972501234567',
      '972501234567',
      '0501234567',
      '+972 50-123-4567',
      '00972 50 1234567',
    ];
    const normalised = new Set(spellings.map(normalizePhone));
    assert.deepEqual([...normalised], ['+972501234567']);
  });

  it('never returns a number that is not E.164', () => {
    for (const [input] of accepted) {
      assert.match(normalizePhone(input), /^\+[1-9]\d{7,14}$/);
    }
  });
});
