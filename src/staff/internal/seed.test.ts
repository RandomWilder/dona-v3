import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../../kernel/pg-support.ts';
import { createStaffAuth } from './auth.ts';
import { seedStaffOperator } from './seed.ts';

const password = 'correct-horse-battery';

describe('staff seed', () => {
  it('does nothing when nothing is configured', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const result = await seedStaffOperator(createStaffAuth(pool), {});
      assert.deepEqual(result, {
        seeded: false,
        reason: 'no seed configured',
      });
    } finally {
      await pool.end();
    }
  });

  it('creates once and is a no-op on every boot after', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      const email = `seed-${newId()}@dona.test`;

      assert.deepEqual(await seedStaffOperator(auth, { email, password }), {
        seeded: true,
        reason: 'created',
      });
      assert.deepEqual(await seedStaffOperator(auth, { email, password }), {
        seeded: false,
        reason: 'already exists',
      });

      // The seeded account is usable, which is the whole point.
      const session = await auth.login(email, password);
      assert.equal(session.operator.email, email);
      // And it is an admin: it is the only account at boot, so anything less
      // would deploy a system nobody can administer.
      assert.equal(session.operator.role, 'admin');
    } finally {
      await pool.end();
    }
  });

  it('fails loudly on half a configuration', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      await assert.rejects(
        seedStaffOperator(auth, { email: 'someone@dona.test' }),
        (error: KernelError) => error.code === 'invalid',
      );
      await assert.rejects(
        seedStaffOperator(auth, { password }),
        (error: KernelError) => error.code === 'invalid',
      );
    } finally {
      await pool.end();
    }
  });

  // A weak seed must stop the boot rather than become the way in.
  it('refuses to seed a short password', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      await assert.rejects(
        seedStaffOperator(auth, {
          email: `seed-${newId()}@dona.test`,
          password: 'short',
        }),
        (error: KernelError) => error.code === 'invalid',
      );
    } finally {
      await pool.end();
    }
  });
});
