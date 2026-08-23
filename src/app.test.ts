import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { buildApp } from './app.ts';
import { migratedPoolOrNull, skipReason } from './kernel/pg-support.ts';

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

// The shells never touch the database, so an unused pool is enough here.
function appWithoutDatabase() {
  const pool = new Pool({
    connectionString: 'postgres://dona:dona@127.0.0.1:59999/dona',
    connectionTimeoutMillis: 500,
    allowExitOnIdle: true,
  });
  return { app: buildApp({ pool, version: '9.9.9-test' }), pool };
}

describe('error shape at the edge', () => {
  it('renders an unknown route through the kernel error shape', async () => {
    const { app, pool } = appWithoutDatabase();
    try {
      const response = await app.inject({ method: 'GET', url: '/ui/app.ts' });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), {
        code: 'not_found',
        message: 'route not found',
      });
      // Fastify's own 404 echoes the requested path back; ours does not.
      assert.doesNotMatch(response.body, /app\.ts/);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('never lets a raw error reach the wire', async () => {
    const { app, pool } = appWithoutDatabase();
    app.get('/boom', async () => {
      throw new Error('connection string postgres://user:secret@host/db');
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/boom' });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        code: 'unavailable',
        message: 'unexpected error',
      });
      assert.doesNotMatch(response.body, /secret/);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

describe('presentation shells', () => {
  it('gates /admin behind a session and serves the tenant shell openly', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    try {
      const admin = await app.inject({ method: 'GET', url: '/admin' });
      assert.equal(admin.statusCode, 302);
      assert.equal(admin.headers.location, '/admin/login');

      const tenant = await app.inject({ method: 'GET', url: '/t/anything' });
      assert.equal(tenant.statusCode, 200);
      assert.match(tenant.body, /<html lang="he" dir="rtl">/);
      assert.match(tenant.body, /<textarea[^>]*disabled/);
      assert.match(tenant.body, /<button[^>]*disabled/);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('never echoes the link parameter into the page', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    try {
      const injected = '<script>alert(1)</script>';
      const response = await app.inject({
        method: 'GET',
        url: `/t/${encodeURIComponent(injected)}`,
      });
      assert.equal(response.statusCode, 200);
      assert.doesNotMatch(response.body, /alert\(1\)/);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('sends the bare URL to where the system starts', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    try {
      const response = await app.inject({ method: 'GET', url: '/' });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin');
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
