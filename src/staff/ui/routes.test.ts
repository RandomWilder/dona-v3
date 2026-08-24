import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../../app.ts';
import { newId } from '../../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../../kernel/pg-support.ts';
import { createStaffAuth } from '../internal/auth.ts';

const password = 'correct-horse-battery';

function form(email: string, secret: string) {
  return {
    method: 'POST' as const,
    url: '/admin/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email, password: secret }).toString(),
  };
}

function cookieValue(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : (header ?? '');
  return raw.split(';')[0];
}

describe('staff login', () => {
  it('runs the whole gate: refuse, admit, use, leave', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    const email = `ops-${newId()}@dona.test`;
    try {
      await createStaffAuth(pool).createOperator({
        email,
        password,
        role: 'admin',
      });

      // Locked out to begin with.
      const closed = await app.inject({ method: 'GET', url: '/admin' });
      assert.equal(closed.statusCode, 302);
      assert.equal(closed.headers.location, '/admin/login');

      // A wrong password says nothing and hands out no cookie.
      const refused = await app.inject(form(email, 'wrong-password-here'));
      assert.equal(refused.statusCode, 302);
      assert.equal(refused.headers.location, '/admin/login?error=1');
      assert.equal(refused.headers['set-cookie'], undefined);

      // The right one does.
      const admitted = await app.inject(form(email, password));
      assert.equal(admitted.statusCode, 302);
      assert.equal(admitted.headers.location, '/admin');
      const setCookie = Array.isArray(admitted.headers['set-cookie'])
        ? admitted.headers['set-cookie'][0]
        : (admitted.headers['set-cookie'] as string);
      assert.match(setCookie, /^dona_session=[0-9a-f]{64}/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      // Local injection is http, so the cookie must not claim Secure.
      assert.doesNotMatch(setCookie, /Secure/);

      const cookie = cookieValue(setCookie);
      const shell = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie },
      });
      assert.equal(shell.statusCode, 200);
      assert.match(shell.body, /data-dest="queue"/);
      // A session you cannot end is not a session you control.
      assert.match(shell.body, /action="\/admin\/logout"/);
      // An authenticated screen must not be cacheable, bfcache included.
      assert.equal(shell.headers['cache-control'], 'no-store');

      // Already in: the login page sends you on rather than asking again.
      const again = await app.inject({
        method: 'GET',
        url: '/admin/login',
        headers: { cookie },
      });
      assert.equal(again.statusCode, 302);
      assert.equal(again.headers.location, '/admin');

      const out = await app.inject({
        method: 'POST',
        url: '/admin/logout',
        headers: { cookie },
      });
      assert.equal(out.statusCode, 302);
      assert.equal(out.headers.location, '/admin/login');

      // The cookie the browser still holds is now worthless.
      const after = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie },
      });
      assert.equal(after.statusCode, 302);
      assert.equal(after.headers.location, '/admin/login');
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('marks the cookie Secure when the request arrived over https', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    const email = `ops-${newId()}@dona.test`;
    try {
      await createStaffAuth(pool).createOperator({
        email,
        password,
        role: 'admin',
      });
      const request = form(email, password);
      const response = await app.inject({
        ...request,
        // What Cloud Run's front end sets; the process itself only ever sees http.
        headers: { ...request.headers, 'x-forwarded-proto': 'https' },
      });
      const setCookie = Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie'][0]
        : (response.headers['set-cookie'] as string);
      assert.match(setCookie, /Secure/);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('shows the error only when asked, and never echoes the query', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    try {
      const clean = await app.inject({ method: 'GET', url: '/admin/login' });
      assert.equal(clean.statusCode, 200);
      assert.match(clean.body, /id="login-error" hidden/);

      const failed = await app.inject({
        method: 'GET',
        url: '/admin/login?error=1',
      });
      assert.equal(failed.statusCode, 200);
      assert.match(failed.body, /id="login-error">/);
      assert.doesNotMatch(failed.body, /id="login-error" hidden/);

      // The parameter decides a boolean; it is never rendered.
      const injected = await app.inject({
        method: 'GET',
        url: `/admin/login?error=${encodeURIComponent('<script>alert(1)</script>')}`,
      });
      assert.equal(injected.statusCode, 200);
      assert.doesNotMatch(injected.body, /alert\(1\)/);
      assert.match(injected.body, /id="login-error" hidden/);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('refuses a request with no body at all, the same way', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    const app = buildApp({ pool, version: '9.9.9-test' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/login?error=1');
      assert.equal(response.headers['set-cookie'], undefined);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
