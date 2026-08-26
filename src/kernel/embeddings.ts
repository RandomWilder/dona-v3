import { createHash } from 'node:crypto';
import { KernelError } from './errors.ts';

// Text in, numbers out. Infrastructure on the footing objects.ts and pdf.ts
// stand on: the shape of a call and no business logic -- it does not know what a
// lease or a clause is.
//
// This is the first model call this project makes. Weeks 1-2 built an operations
// system of record with no AI in it at all, and SPEC.md rule 2 governs what
// happens from here: the agent is a client, never a brain. This is a client of
// the narrowest kind -- no prompt, no tools, no judgement.

export interface Embedder {
  // One vector per text, in the order the texts arrived. A caller pairs them by
  // index, so the order is part of the contract rather than a convenience.
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  dimensions: number;
  // For the boot line, as ObjectStore.describe() is.
  describe(): string;
}

export interface OpenAiEmbedderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  // Injected in tests so the call is fakeable without a network or a key, the
  // same seam createGcsStore uses.
  fetchImpl?: typeof fetch;
  endpoint?: string;
  batchSize?: number;
}

const defaultEndpoint = 'https://api.openai.com/v1/embeddings';

// Large enough that a 273-clause lease is three calls rather than 273, small
// enough to stay well inside the request size limit for long clauses.
const defaultBatchSize = 96;

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

export function createOpenAiEmbedder(options: OpenAiEmbedderOptions): Embedder {
  const { apiKey, model, dimensions } = options;
  const call = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? defaultEndpoint;
  const batchSize = options.batchSize ?? defaultBatchSize;

  return {
    model,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) {
        return [];
      }
      const vectors: number[][] = [];
      for (let at = 0; at < texts.length; at += batchSize) {
        const batch = texts.slice(at, at + batchSize);
        const response = await call(endpoint, {
          method: 'POST',
          headers: {
            // The one place the key is used, and it is never logged: an error
            // below reports status and the provider's message, never headers.
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          // `dimensions` is what keeps ROADMAP's named model at a width pgvector
          // can index -- hnsw caps at 2000 and this model is natively 3072.
          body: JSON.stringify({ model, input: batch, dimensions }),
        });
        if (!response.ok) {
          throw new KernelError('unavailable', 'the embedding call failed', {
            status: response.status,
          });
        }
        const body = (await response.json()) as EmbeddingResponse;
        vectors.push(...readVectors(body, batch.length, dimensions));
      }
      return vectors;
    },
    describe: () => `openai:${model}@${dimensions}`,
  };
}

// The default when nothing configured a key. It throws rather than returning
// zeros, on the argument createUnconfiguredStore makes: a process that lost its
// key must not index a lease into vectors that match nothing. That failure is
// invisible until a tenant asks a question and gets silence.
export function createUnconfiguredEmbedder(): Embedder {
  return {
    model: 'none',
    dimensions: 0,
    async embed() {
      throw new KernelError('unavailable', 'no embedder is configured');
    },
    describe: () => 'unconfigured',
  };
}

// What the tests use, so no test reaches the network and none needs a key.
// Deterministic on the text: the same string always yields the same vector, and
// two different strings almost never collide -- which is what lets an isolation
// test assert that a search found this document's clause and not that one's.
//
// It is not a semantic model and does not pretend to be. Tests that need
// "similar text ranks higher" say so by embedding the exact string.
export function createFakeEmbedder(dimensions: number): Embedder {
  return {
    model: 'fake',
    dimensions,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        // A hash walked across the vector: cheap, stable across processes, and
        // free of the collisions a naive character sum would produce between
        // anagrams -- which a lease, full of repeated legal phrasing, has.
        const digest = createHash('sha256').update(text).digest();
        for (let at = 0; at < dimensions; at += 1) {
          vector[at] = (digest[at % digest.length] ?? 0) / 255 - 0.5;
        }
        return normalize(vector);
      });
    },
    describe: () => `fake@${dimensions}`,
  };
}

function readVectors(
  body: EmbeddingResponse,
  expected: number,
  dimensions: number,
): number[][] {
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new KernelError('unavailable', 'the embedding reply was incomplete', {
      expected,
      received: Array.isArray(data) ? data.length : 0,
    });
  }
  // The provider documents that results may arrive out of order, and pairing a
  // clause with another clause's vector is a silent corruption -- every answer
  // afterwards cites the wrong text. Sorted by the index it reports, then
  // checked, rather than trusted.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((item, at) => {
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.length !== dimensions) {
      throw new KernelError('unavailable', 'an embedding had the wrong width', {
        at,
        expected: dimensions,
        received: Array.isArray(vector) ? vector.length : 0,
      });
    }
    return vector;
  });
}

function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}
