import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFakeEmbedder,
  createOpenAiEmbedder,
  createUnconfiguredEmbedder,
} from './embeddings.ts';
import type { KernelError } from './errors.ts';

// The OpenAI adapter is exercised through an injected fetch: what is worth
// testing here is the shape of the request and how a bad reply is reported, not
// that OpenAI works. The real call is proved on staging by the slice's own
// verify step. Same argument, same seam, as objects.test.ts makes for GCS.
function fakeFetch(handler: (body: Record<string, unknown>) => Response): {
  calls: Array<{ url: string; body: Record<string, unknown>; auth: string }>;
  impl: typeof fetch;
} {
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    auth: string;
  }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), body, auth: headers.authorization ?? '' });
    return handler(body);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function reply(vectors: number[][], indexes?: number[]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, at) => ({
        index: indexes?.[at] ?? at,
        embedding,
      })),
    }),
    { status: 200 },
  );
}

const width = 4;
const vector = (seed: number) => new Array<number>(width).fill(seed);

describe('embeddings', () => {
  it('asks for the configured model at the configured width', async () => {
    const fetcher = fakeFetch(() => reply([vector(1)]));
    const embedder = createOpenAiEmbedder({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      dimensions: width,
      fetchImpl: fetcher.impl,
    });

    const vectors = await embedder.embed(['סעיף 10 — דמי השכירות']);

    assert.deepEqual(vectors, [vector(1)]);
    const call = fetcher.calls[0];
    assert.equal(call?.body.model, 'text-embedding-3-large');
    // The parameter that keeps ROADMAP's named model at a width pgvector can
    // index: hnsw caps at 2000 and this model is natively 3072.
    assert.equal(call?.body.dimensions, width);
    assert.equal(call?.auth, 'Bearer sk-test');
    assert.equal(embedder.describe(), `openai:text-embedding-3-large@${width}`);
  });

  it('batches a long document rather than sending one call per clause', async () => {
    const fetcher = fakeFetch((body) =>
      reply((body.input as string[]).map((_, at) => vector(at))),
    );
    const embedder = createOpenAiEmbedder({
      apiKey: 'sk-test',
      model: 'm',
      dimensions: width,
      fetchImpl: fetcher.impl,
      batchSize: 2,
    });

    const vectors = await embedder.embed(['a', 'b', 'c', 'd', 'e']);

    assert.equal(vectors.length, 5);
    assert.deepEqual(
      fetcher.calls.map((call) => (call.body.input as string[]).length),
      [2, 2, 1],
    );
  });

  it('pairs each text with its own vector when the reply arrives out of order', async () => {
    // The provider documents that results may come back unordered. Pairing a
    // clause with another clause's vector is a silent corruption: every answer
    // afterwards cites the wrong text, and nothing about it looks broken.
    const fetcher = fakeFetch(() =>
      reply([vector(9), vector(7), vector(8)], [2, 0, 1]),
    );
    const embedder = createOpenAiEmbedder({
      apiKey: 'sk-test',
      model: 'm',
      dimensions: width,
      fetchImpl: fetcher.impl,
    });

    assert.deepEqual(await embedder.embed(['first', 'second', 'third']), [
      vector(7),
      vector(8),
      vector(9),
    ]);
  });

  it('refuses a reply that is short, or the wrong width', async () => {
    const short = createOpenAiEmbedder({
      apiKey: 'k',
      model: 'm',
      dimensions: width,
      fetchImpl: fakeFetch(() => reply([vector(1)])).impl,
    });
    await assert.rejects(
      short.embed(['a', 'b']),
      (error: KernelError) => error.code === 'unavailable',
    );

    const narrow = createOpenAiEmbedder({
      apiKey: 'k',
      model: 'm',
      dimensions: width,
      fetchImpl: fakeFetch(() => reply([[1, 2]])).impl,
    });
    await assert.rejects(
      narrow.embed(['a']),
      (error: KernelError) => error.code === 'unavailable',
    );
  });

  it('reports a failed call as unavailable, without the key in it', async () => {
    const embedder = createOpenAiEmbedder({
      apiKey: 'sk-secret-value',
      model: 'm',
      dimensions: width,
      fetchImpl: fakeFetch(() => new Response('nope', { status: 429 })).impl,
    });
    const error = await embedder.embed(['a']).then(
      () => null,
      (thrown: KernelError) => thrown,
    );
    assert.equal(error?.code, 'unavailable');
    assert.doesNotMatch(JSON.stringify(error?.details ?? {}), /sk-secret/);
    assert.doesNotMatch(error?.message ?? '', /sk-secret/);
  });

  it('sends nothing at all for no texts', async () => {
    const fetcher = fakeFetch(() => reply([]));
    const embedder = createOpenAiEmbedder({
      apiKey: 'k',
      model: 'm',
      dimensions: width,
      fetchImpl: fetcher.impl,
    });
    assert.deepEqual(await embedder.embed([]), []);
    assert.equal(fetcher.calls.length, 0);
  });

  it('refuses when nothing configured a key, rather than returning zeros', async () => {
    // The failure a zero vector would hide: a lease indexed into vectors that
    // match nothing, invisible until a tenant asks a question and gets silence.
    const embedder = createUnconfiguredEmbedder();
    await assert.rejects(
      embedder.embed(['a']),
      (error: KernelError) => error.code === 'unavailable',
    );
    assert.equal(embedder.describe(), 'unconfigured');
  });

  it('gives the fake embedder a stable vector per text', async () => {
    const embedder = createFakeEmbedder(8);
    const [first] = await embedder.embed(['נספח א׳ §10']);
    const [again] = await embedder.embed(['נספח א׳ §10']);
    const [other] = await embedder.embed(['נספח א׳ §5']);

    assert.deepEqual(first, again);
    assert.notDeepEqual(first, other);
    assert.equal(first?.length, 8);
  });
});
