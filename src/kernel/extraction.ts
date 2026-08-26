import { KernelError } from './errors.ts';

// Text and a schema in, JSON out. The second model port, and the first one with
// a prompt: embeddings.ts had no instructions and no judgement, and this has
// both. It still knows nothing about leases -- it is handed instructions, text
// and a schema, exactly as pdf.ts is handed bytes.
//
// SPEC.md rule 2 governs it the same way: the model is a client of the module
// that calls it, never the place a decision lives. What a lease field is, which
// clauses are worth sending and whether an answer may be believed are all
// decisions of `occupancy/internal/twin.ts`, not of this file.

// The kernel holds the shape of a call, not the shape of a schema. What is in
// here is the provider's business and the caller's; validating it would be a
// second, weaker copy of the check twin.ts runs on the reply.
export type JsonSchema = Record<string, unknown>;

export interface ExtractionRequest {
  // Per call, unlike the embedder's model. See SPEC-kernel.md, "Two settings,
  // read at two different times": this one is welded to nothing already stored,
  // and a model id the account cannot serve has to be fixable with one row.
  model: string;
  // Names the schema for the provider, and names the call in an error.
  name: string;
  instructions: string;
  input: string;
  schema: JsonSchema;
  // How much reasoning the model is asked to spend. Absent means the parameter
  // is not sent at all, which is what a model with no reasoning setting needs:
  // it rejects an unknown field rather than ignoring it.
  //
  // Sending nothing is *not* the same as asking for none. Unset means the
  // provider's default -- which is where slice 13.1's first staging press went,
  // and why five calls did not finish inside a 300-second request.
  reasoningEffort?: string;
}

export interface Extractor {
  // `unknown`, deliberately. A strict schema makes a malformed reply unlikely
  // and not impossible, and a port that promised a typed value would be making
  // the caller's guarantee on the provider's behalf.
  extract(request: ExtractionRequest): Promise<unknown>;
  // For the boot line, as ObjectStore.describe() and Embedder.describe() are.
  describe(): string;
}

export interface OpenAiExtractorOptions {
  apiKey: string;
  // Injected in tests so the call is fakeable without a network or a key, the
  // same seam createGcsStore and createOpenAiEmbedder use.
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

const defaultEndpoint = 'https://api.openai.com/v1/chat/completions';

// Code and not config rows, on the argument occupancy's document size cap
// makes: rule 4 governs tunables, and a bound that stops one request consuming
// a server is a safety limit rather than a policy.
//
// Sixty seconds because the caller is a browser request that the platform cuts
// off at 300. A call that has not answered in a minute must become an error
// somebody can read, *before* the platform turns it into a blank page with no
// message in it -- which is exactly what 13.1's first staging press produced.
export const defaultTimeoutMs = 60_000;

// A bound on a runaway, not a budget: the reply is a handful of fields.
// Reasoning tokens count against it, so a model asked to think hard can reach
// it -- and reaching it is reported as truncation, which is legible.
export const defaultMaxOutputTokens = 8_000;

interface CompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

export function createOpenAiExtractor(
  options: OpenAiExtractorOptions,
): Extractor {
  const { apiKey } = options;
  const call = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? defaultEndpoint;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxOutputTokens = options.maxOutputTokens ?? defaultMaxOutputTokens;

  function requestBody(request: ExtractionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        { role: 'system', content: request.instructions },
        { role: 'user', content: request.input },
      ],
      // Strict, because the alternative is this file parsing prose. A schema
      // the provider enforces is the difference between a malformed reply being
      // an error and being a plausible wrong shape.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.name,
          schema: request.schema,
          strict: true,
        },
      },
      max_completion_tokens: maxOutputTokens,
    };
    // Omitted entirely when the caller did not ask for one, rather than sent
    // empty: a model without the setting refuses the field.
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }
    return body;
  }

  return {
    async extract(request) {
      let response: Response;
      try {
        response = await call(endpoint, {
          method: 'POST',
          headers: {
            // The one place the key is used, and it is never logged: an error
            // below reports status and nothing about the request.
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody(request)),
          // The bound. Without it, the only thing that ends a slow call is the
          // platform's own request timeout, which arrives as a blank page
          // rather than as a sentence naming the field being read.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof KernelError) {
          throw error;
        }
        // Any failure to *reach* the provider, timeout included, and the
        // timeout is the one worth naming: it is the difference between "the
        // model said no" and "nobody answered in a minute".
        throw new KernelError('unavailable', 'the extraction call timed out', {
          name: request.name,
          timeoutMs,
        });
      }
      if (!response.ok) {
        throw new KernelError('unavailable', 'the extraction call failed', {
          status: response.status,
          name: request.name,
        });
      }
      const body = (await response.json()) as CompletionResponse;
      return readContent(body, request.name);
    },
    describe: () => 'openai',
  };
}

// The default when nothing configured a key. It throws rather than returning an
// empty object, on the argument createUnconfiguredEmbedder makes: a twin with no
// fields and a twin nobody could read look identical on every screen, and the
// second one is a lease the system has quietly decided says nothing.
export function createUnconfiguredExtractor(): Extractor {
  return {
    async extract() {
      throw new KernelError('unavailable', 'no extractor is configured');
    },
    describe: () => 'unconfigured',
  };
}

// What the tests use, so no test reaches the network and none needs a key. The
// calls are exposed because they are what several tests are about: which
// clauses were sent is a decision this repo makes, and a test that cannot see
// the request cannot assert that the front page stayed home.
export function createFakeExtractor(
  reply: (request: ExtractionRequest) => unknown,
): Extractor & { calls: ExtractionRequest[] } {
  const calls: ExtractionRequest[] = [];
  return {
    calls,
    async extract(request) {
      calls.push(request);
      return reply(request);
    },
    describe: () => 'fake',
  };
}

function readContent(body: CompletionResponse, name: string): unknown {
  const choice = body?.choices?.[0];
  // A model may decline rather than answer. That is a reply, not a failure of
  // the transport, and it must not be parsed as JSON or reported as one.
  if (typeof choice?.message?.refusal === 'string' && choice.message.refusal) {
    throw new KernelError('unavailable', 'the model declined to extract', {
      name,
    });
  }
  // A reply cut off at the token limit is *valid-looking prefix*, which is the
  // one failure worth naming separately: it parses as nothing, but it would
  // parse as something if anyone tried to repair it.
  if (choice?.finish_reason === 'length') {
    throw new KernelError('unavailable', 'the extraction reply was truncated', {
      name,
    });
  }
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new KernelError('unavailable', 'the extraction reply was empty', {
      name,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Never the provider's text in the details: it is the lease's own words
    // coming back, and an error body is a place they must not land.
    throw new KernelError('unavailable', 'the extraction reply was not JSON', {
      name,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KernelError(
      'unavailable',
      'the extraction reply was not an object',
      {
        name,
      },
    );
  }
  return parsed;
}
