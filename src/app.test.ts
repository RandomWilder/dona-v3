import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { buildApp } from './app.ts';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://dona:dona@127.0.0.1:5434/dona';

describe('/health', () => {
  it('reports ok with version and db up', async (t) => {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1500,
      allowExitOnIdle: true,
    });
    try {
      await pool.query('SELECT 1');
    } catch {
      await pool.end();
      t.skip('postgres not running — npm run db:up');
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        ok: true,
        version: '9.9.9-test',
        db: 'up',
      });
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('degrades to 503 with the kernel error shape when the db is down', async () => {
    const deadPool = new Pool({
      connectionString: 'postgres://dona:dona@127.0.0.1:59999/dona',
      connectionTimeoutMillis: 500,
      allowExitOnIdle: true,
    });
    const app = buildApp({ pool: deadPool, version: '9.9.9-test' });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 503);
      const body = response.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, 'unavailable');
      assert.equal(typeof body.message, 'string');
    } finally {
      await app.close();
      await deadPool.end();
    }
  });
});
