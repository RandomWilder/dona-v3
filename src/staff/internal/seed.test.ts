import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../../kernel/pg-support.ts';
import { createStaffAuth } from './auth.ts';
import { seedStaffOperator, seedStaffViewer } from './seed.ts';

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

  it('seeds a viewer, and only ever a viewer', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      const email = `viewer-${newId()}@dona.test`;
      const created = await seedStaffViewer(auth, { email, password });
      assert.deepEqual(created, { seeded: true, reason: 'created' });

      // The role is the whole point: a viewer seeded as an admin would make the
      // week-2 demo a lie, and nothing else here would notice.
      const session = await auth.login(email, password);
      assert.equal(session.operator.role, 'viewer');

      // Idempotent on every boot after, like the admin seed.
      assert.deepEqual(await seedStaffViewer(auth, { email, password }), {
        seeded: false,
        reason: 'already exists',
      });
    } finally {
      await pool.end();
    }
  });

  it('leaves an environment with no viewer configured alone', async (t) => {
    // Where the admin seed is required, this one is not: an environment without
    // it has one less demo account, not no way in.
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      assert.deepEqual(await seedStaffViewer(createStaffAuth(pool), {}), {
        seeded: false,
        reason: 'no seed configured',
      });
    } finally {
      await pool.end();
    }
  });

  it('still fails loudly on half a viewer configuration', async (t) => {
    // Optional means "absent", not "partly set" — and the message names the
    // pair that is actually wrong.
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      await assert.rejects(
        seedStaffViewer(auth, { email: 'someone@dona.test' }),
        (error: KernelError) =>
          error.code === 'invalid' &&
          error.message.includes('STAFF_VIEWER_EMAIL'),
      );
      await assert.rejects(
        seedStaffViewer(auth, { password }),
        (error: KernelError) => error.code === 'invalid',
      );
    } finally {
      await pool.end();
    }
  });

  it('seeds an admin and a viewer side by side, neither overwriting the other', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const auth = createStaffAuth(pool);
      const adminEmail = `admin-${newId()}@dona.test`;
      const viewerEmail = `viewer-${newId()}@dona.test`;
      await seedStaffOperator(auth, { email: adminEmail, password });
      await seedStaffViewer(auth, { email: viewerEmail, password });

      // Both boots run again, as they do on every deploy.
      await seedStaffOperator(auth, { email: adminEmail, password });
      await seedStaffViewer(auth, { email: viewerEmail, password });

      const admin = await auth.login(adminEmail, password);
      const viewer = await auth.login(viewerEmail, password);
      assert.equal(admin.operator.role, 'admin');
      assert.equal(viewer.operator.role, 'viewer');
      assert.notEqual(admin.operator.id, viewer.operator.id);
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
