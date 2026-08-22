import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPool } from './db.ts';
import { KernelError } from './errors.ts';

describe('createPool', () => {
  it('rejects a missing DATABASE_URL with the kernel error shape', () => {
    assert.throws(
      () => createPool({}),
      (error: unknown) =>
        error instanceof KernelError && error.code === 'invalid',
    );
  });

  it('builds a pool from DATABASE_URL', async () => {
    const pool = createPool({
      DATABASE_URL: 'postgres://dona:dona@127.0.0.1:5434/dona',
    });
    await pool.end();
  });
});
