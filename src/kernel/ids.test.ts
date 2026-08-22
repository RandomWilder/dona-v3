import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixedClock } from './clock.ts';
import { idFromParts, newId } from './ids.ts';

const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('produces RFC 9562 UUIDv7 strings', () => {
    assert.match(newId(), uuidV7);
  });

  it('never repeats across a batch', () => {
    const batch = new Set(Array.from({ length: 10_000 }, () => newId()));
    assert.equal(batch.size, 10_000);
  });

  it('sorts by creation time under an injected clock', () => {
    const clock = fixedClock(new Date('2026-08-22T10:00:00Z'));
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(newId(clock));
      clock.advance(1);
    }
    assert.deepEqual([...ids].sort(), ids);
  });
});

describe('idFromParts', () => {
  it('encodes the timestamp in the first 48 bits', () => {
    const id = idFromParts(0x0123456789ab, new Uint8Array(10));
    assert.equal(id.slice(0, 13), '01234567-89ab');
    assert.match(id, uuidV7);
  });

  it('forces version and variant bits regardless of random input', () => {
    const id = idFromParts(Date.now(), new Uint8Array(10).fill(0xff));
    assert.match(id, uuidV7);
  });
});
