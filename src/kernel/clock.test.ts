import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixedClock, systemClock } from './clock.ts';

describe('fixedClock', () => {
  it('advances deterministically, without sleeping', () => {
    const clock = fixedClock(new Date('2026-08-22T10:00:00Z'));
    assert.equal(clock.now().toISOString(), '2026-08-22T10:00:00.000Z');
    clock.advance(90_000);
    assert.equal(clock.now().toISOString(), '2026-08-22T10:01:30.000Z');
  });

  it('returns independent Date instances', () => {
    const clock = fixedClock(new Date(0));
    const first = clock.now();
    clock.advance(1);
    assert.equal(first.getTime(), 0);
  });
});

describe('systemClock', () => {
  it('tracks real time', () => {
    const before = Date.now();
    const observed = systemClock.now().getTime();
    const after = Date.now();
    assert.ok(before <= observed && observed <= after);
  });
});
