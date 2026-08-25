import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from './errors.ts';
import { createGcsStore, createMemoryStore } from './objects.ts';

// The GCS store is exercised through an injected fetch: what is worth testing
// here is the shape of the request and how a failure is reported, not that
// Google's API works. The real thing is proved on staging by the slice's own
// verify step.
function fakeFetch(handler: (url: string, init?: RequestInit) => Response): {
  calls: Array<{ url: string; init?: RequestInit }>;
  impl: typeof fetch;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('object store', () => {
  it('round-trips bytes through memory', async () => {
    const store = createMemoryStore();
    await store.put(
      'leases/a/b.pdf',
      Buffer.from('%PDF-1.7'),
      'application/pdf',
    );
    const read = await store.read('leases/a/b.pdf');
    assert.equal(read.bytes.toString(), '%PDF-1.7');
    assert.equal(read.contentType, 'application/pdf');
  });

  it('copies on the way in, so a caller cannot mutate what it stored', async () => {
    const store = createMemoryStore();
    const bytes = Buffer.from('original');
    await store.put('p', bytes, 'application/pdf');
    bytes.write('OVERWRIT');
    assert.equal((await store.read('p')).bytes.toString(), 'original');
  });

  it('says not_found rather than returning an empty object', async () => {
    const store = createMemoryStore();
    await assert.rejects(store.read('missing'), (error: KernelError) => {
      assert.equal(error.code, 'not_found');
      return true;
    });
  });

  it('names which store is running, for the boot line', () => {
    assert.equal(createMemoryStore().describe(), 'memory');
    assert.equal(
      createGcsStore({ bucket: 'dona-v3-staging-docs' }).describe(),
      'gs://dona-v3-staging-docs',
    );
  });

  it('encodes the whole object name, slashes included', async () => {
    const fake = fakeFetch(() => new Response('', { status: 200 }));
    const store = createGcsStore({
      bucket: 'b',
      fetchImpl: fake.impl,
      token: async () => 'token',
    });
    await store.put(
      'leases/bldg-1/unit-2/lease-3.pdf',
      Buffer.from('x'),
      'application/pdf',
    );
    // A slash left raw would address a different object than the one the row
    // records.
    assert.match(
      fake.calls[0]?.url ?? '',
      /name=leases%2Fbldg-1%2Funit-2%2Flease-3\.pdf/,
    );
    assert.equal(fake.calls[0]?.init?.method, 'POST');
  });

  it('turns a 404 into not_found and any other failure into unavailable', async () => {
    const missing = fakeFetch(() => new Response('', { status: 404 }));
    await assert.rejects(
      createGcsStore({
        bucket: 'b',
        fetchImpl: missing.impl,
        token: async () => 't',
      }).read('p'),
      (error: KernelError) => error.code === 'not_found',
    );

    const broken = fakeFetch(
      () =>
        new Response('object leases/tenant-name.pdf denied', { status: 403 }),
    );
    await assert.rejects(
      createGcsStore({
        bucket: 'b',
        fetchImpl: broken.impl,
        token: async () => 't',
      }).read('p'),
      (error: KernelError) => {
        assert.equal(error.code, 'unavailable');
        // The body is never echoed: a storage error can carry the object name,
        // and the name is on its way into a log.
        assert.ok(!error.message.includes('leases/'));
        return true;
      },
    );
  });
});
