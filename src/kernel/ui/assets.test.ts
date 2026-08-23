import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerUiAssets } from './assets.ts';

function appWithAssets() {
  const app = Fastify({ logger: false });
  registerUiAssets(app);
  return app;
}

describe('shared UI assets', () => {
  it('serves the token stylesheet as CSS', async () => {
    const app = appWithAssets();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ui/tokens.css',
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] as string, /text\/css/);
      assert.match(response.body, /--color-chrome/);
      assert.match(response.body, /@font-face/);
    } finally {
      await app.close();
    }
  });

  it('serves every allowlisted font as immutable woff2', async () => {
    const app = appWithAssets();
    const names = [
      'heebo-hebrew.woff2',
      'heebo-latin.woff2',
      'ibm-plex-mono-latin-400.woff2',
      'ibm-plex-mono-latin-500.woff2',
    ];
    try {
      for (const name of names) {
        const response = await app.inject({
          method: 'GET',
          url: `/ui/fonts/${name}`,
        });
        assert.equal(response.statusCode, 200, name);
        assert.equal(response.headers['content-type'], 'font/woff2');
        assert.match(
          response.headers['cache-control'] as string,
          /immutable/,
          name,
        );
        // wOF2 magic number: proof it is the real file, not an empty buffer.
        assert.equal(response.rawPayload.subarray(0, 4).toString(), 'wOF2');
      }
    } finally {
      await app.close();
    }
  });

  it('refuses anything not on the allowlist, traversal included', async () => {
    const app = appWithAssets();
    const attempts = [
      '/ui/fonts/nope.woff2',
      '/ui/fonts/tokens.css',
      '/ui/fonts/..%2f..%2fapp.ts',
      '/ui/fonts/%2e%2e%2f%2e%2e%2fapp.ts',
      '/ui/fonts/..%2fassets.ts',
    ];
    try {
      for (const url of attempts) {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 404, url);
        assert.doesNotMatch(response.body, /registerUiAssets/, url);
      }
    } finally {
      await app.close();
    }
  });

  it('renders a missing asset through the kernel error shape', async () => {
    const app = appWithAssets();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ui/fonts/nope.woff2',
      });
      const body = response.json();
      assert.equal(body.code, 'not_found');
      assert.equal(typeof body.message, 'string');
    } finally {
      await app.close();
    }
  });
});
