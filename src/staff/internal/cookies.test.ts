import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearSessionCookie,
  readSessionToken,
  sessionCookie,
} from './cookies.ts';

const now = new Date('2026-08-23T09:00:00Z');

describe('session cookie', () => {
  it('is HttpOnly and SameSite=Lax, and Secure only over https', () => {
    const expires = new Date(now.getTime() + 3600_000);
    const insecure = sessionCookie('abc', expires, now, false);
    const secure = sessionCookie('abc', expires, now, true);

    for (const cookie of [insecure, secure]) {
      assert.match(cookie, /^dona_session=abc;/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.match(cookie, /Max-Age=3600/);
      assert.match(cookie, /Path=\//);
    }
    assert.doesNotMatch(insecure, /Secure/);
    assert.match(secure, /Secure/);
  });

  // The lifetime comes from the injected clock, not Date.now().
  it('never emits a negative Max-Age for an already-expired session', () => {
    const past = new Date(now.getTime() - 60_000);
    assert.match(sessionCookie('abc', past, now, true), /Max-Age=0/);
  });

  it('clears with an immediate expiry and no value', () => {
    assert.match(clearSessionCookie(true), /^dona_session=; /);
    assert.match(clearSessionCookie(true), /Max-Age=0/);
  });

  it('reads its own token back out of a crowded cookie header', () => {
    assert.equal(readSessionToken('other=1; dona_session=tok; z=2'), 'tok');
    assert.equal(readSessionToken('dona_session=tok'), 'tok');
    assert.equal(readSessionToken(undefined), null);
    assert.equal(readSessionToken('other=1'), null);
    assert.equal(readSessionToken('dona_session='), null);
    // A different cookie whose name merely ends the same way is not ours.
    assert.equal(readSessionToken('x_dona_session=tok'), null);
  });
});
