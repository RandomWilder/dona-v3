import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixedClock } from '../../kernel/clock.ts';
import type { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../../kernel/pg-support.ts';
import {
  createStaffAuth,
  hashPassword,
  sessionTtlMs,
  verifyPassword,
} from './auth.ts';

const password = 'correct-horse-battery';

function uniqueEmail(): string {
  return `staff-${newId()}@dona.test`;
}

describe('password records', () => {
  it('round-trips and rejects a wrong password', async () => {
    const record = await hashPassword(password);
    assert.match(record, /^scrypt\$N=16384,r=8,p=1\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.equal(await verifyPassword(password, record), true);
    assert.equal(await verifyPassword('not-it', record), false);
  });

  // The cost has to be raisable without invalidating every stored password,
  // which only works if the verifier reads parameters out of the record.
  it('verifies a record written with different cost parameters', async () => {
    const cheap = await hashPassword(password, { N: 1024, r: 8, p: 1 });
    assert.match(cheap, /^scrypt\$N=1024,/);
    assert.equal(await verifyPassword(password, cheap), true);
    assert.equal(await verifyPassword('not-it', cheap), false);
  });

  it('refuses a malformed record instead of throwing', async () => {
    for (const record of ['', 'garbage', 'scrypt$$$', 'bcrypt$N=1$aa$bb']) {
      assert.equal(await verifyPassword(password, record), false, record);
    }
  });
});

describe('staff auth', () => {
  it('logs in, reads the session back, and logs out', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(new Date('2026-08-23T09:00:00Z'));
      const auth = createStaffAuth(pool, { clock });
      const email = uniqueEmail();
      const operator = await auth.createOperator({ email, password });

      const session = await auth.login(email, password);
      assert.equal(session.operator.id, operator.id);
      assert.equal(
        session.expiresAt.getTime(),
        clock.now().getTime() + sessionTtlMs,
      );

      const read = await auth.readSession(session.token);
      assert.equal(read?.operator.email, email);

      await auth.logout(session.token);
      assert.equal(await auth.readSession(session.token), null);
    } finally {
      await pool.end();
    }
  });

  // The browser holds the only copy. A database read must not yield a usable
  // session token.
  it('never stores the session token itself', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      const email = uniqueEmail();
      await auth.createOperator({ email, password });
      const session = await auth.login(email, password);

      const stored = await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM staff_sessions',
      );
      const hashes = stored.rows.map((row) => row.token_hash);
      assert.ok(hashes.length > 0);
      assert.ok(!hashes.includes(session.token));
    } finally {
      await pool.end();
    }
  });

  it('expires a session on the clock, without sleeping', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(new Date('2026-08-23T09:00:00Z'));
      const auth = createStaffAuth(pool, { clock });
      const email = uniqueEmail();
      await auth.createOperator({ email, password });
      const session = await auth.login(email, password);

      clock.advance(sessionTtlMs - 1000);
      assert.ok(await auth.readSession(session.token));

      clock.advance(2000);
      assert.equal(await auth.readSession(session.token), null);
    } finally {
      await pool.end();
    }
  });

  // An unknown address and a wrong password must be indistinguishable — same
  // code, same message. Timing equality comes from verifying against a dummy
  // record either way; this asserts the observable half.
  it('answers a wrong password and an unknown email identically', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      const email = uniqueEmail();
      await auth.createOperator({ email, password });

      const errors: KernelError[] = [];
      for (const attempt of [
        () => auth.login(email, 'wrong-password-here'),
        () => auth.login(uniqueEmail(), password),
        () => auth.login('not-an-email', password),
      ]) {
        await assert.rejects(attempt, (error: KernelError) => {
          errors.push(error);
          return true;
        });
      }
      assert.deepEqual(
        errors.map((error) => `${error.code}:${error.message}`),
        Array(3).fill('not_allowed:invalid credentials'),
      );
    } finally {
      await pool.end();
    }
  });

  it('throttles after five failures and reopens on the clock', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(new Date('2026-08-23T09:00:00Z'));
      const auth = createStaffAuth(pool, { clock });
      const email = uniqueEmail();
      await auth.createOperator({ email, password });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(auth.login(email, 'wrong-password-here'));
      }

      // The correct password is refused too — that is the point of a throttle.
      await assert.rejects(
        auth.login(email, password),
        (error: KernelError) => {
          assert.equal(error.code, 'not_allowed');
          return true;
        },
      );

      clock.advance(15 * 60 * 1000 + 1000);
      const session = await auth.login(email, password);
      assert.equal(session.operator.email, email);
    } finally {
      await pool.end();
    }
  });

  it('clears the throttle when a login succeeds', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(new Date('2026-08-23T09:00:00Z'));
      const auth = createStaffAuth(pool, { clock });
      const email = uniqueEmail();
      await auth.createOperator({ email, password });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await assert.rejects(auth.login(email, 'wrong-password-here'));
      }
      await auth.login(email, password);

      const left = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM staff_login_attempts WHERE email = $1',
        [email],
      );
      assert.equal(left.rows[0].count, '0');
    } finally {
      await pool.end();
    }
  });

  it('refuses a duplicate email and a short password', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      const email = uniqueEmail();
      await auth.createOperator({ email, password });

      await assert.rejects(
        auth.createOperator({ email, password }),
        (error: KernelError) => error.code === 'conflict',
      );
      await assert.rejects(
        auth.createOperator({ email: uniqueEmail(), password: 'short' }),
        (error: KernelError) => error.code === 'invalid',
      );
    } finally {
      await pool.end();
    }
  });
});
