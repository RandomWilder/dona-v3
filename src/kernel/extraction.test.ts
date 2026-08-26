import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from './errors.ts';
import {
  createFakeExtractor,
  createOpenAiExtractor,
  createUnconfiguredExtractor,
  defaultMaxOutputTokens,
} from './extraction.ts';

// The OpenAI adapter is exercised through an injected fetch, as the embedder's
// is: what is worth testing here is the shape of the request and how a bad
// reply is reported, not that OpenAI works. The real call is proved on staging
// by the slice's own verify step.
function fakeFetch(handler: () => Response | Promise<Response>): {
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
    return handler();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function reply(content: string, finish = 'stop'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finish, message: { content } }],
    }),
    { status: 200 },
  );
}

const request = {
  model: 'gpt-5',
  name: 'lease_term',
  instructions: 'ענה מתוך הסעיפים בלבד.',
  input: 'נספח א׳ §5 — תקופת השכירות',
  schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function refusal(run: () => Promise<unknown>): Promise<KernelError> {
  try {
    await run();
  } catch (error) {
    return error as KernelError;
  }
  return assert.fail('expected a refusal');
}

describe('extraction', () => {
  it('asks the configured model, with the schema enforced strictly', async () => {
    const fetcher = fakeFetch(() => reply('{"ok":true}'));
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    const value = await extractor.extract(request);

    assert.deepEqual(value, { ok: true });
    const call = fetcher.calls[0];
    assert.equal(call?.auth, 'Bearer sk-test');
    assert.equal(call?.body.model, 'gpt-5');
    const format = call?.body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean };
    };
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.name, 'lease_term');
    // The clauses go in the user turn and the rules in the system turn, so the
    // contract's text is never mistaken for an instruction.
    const messages = call?.body.messages as Array<{
      role: string;
      content: string;
    }>;
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'user'],
    );
    assert.equal(messages[1]?.content, request.input);
  });

  it('bounds the reply and sends no reasoning effort unless asked', async () => {
    const fetcher = fakeFetch(() => reply('{"ok":true}'));
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    await extractor.extract(request);

    const call = fetcher.calls[0];
    assert.equal(call?.body.max_completion_tokens, defaultMaxOutputTokens);
    // Absent, not empty. A model without the setting refuses the field, so the
    // way to say "this model has no such knob" is to send nothing at all.
    assert.equal('reasoning_effort' in (call?.body ?? {}), false);
  });

  it('sends the effort it was given, because unset is not none', async () => {
    const fetcher = fakeFetch(() => reply('{"ok":true}'));
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    await extractor.extract({ ...request, reasoningEffort: 'none' });

    // The distinction this test exists for: leaving the parameter out means the
    // provider's default effort, which is what made five calls miss a
    // 300-second request timeout on staging.
    assert.equal(fetcher.calls[0]?.body.reasoning_effort, 'none');
  });

  it('gives up on a call that does not answer, naming the field', async () => {
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      timeoutMs: 20,
      // A provider that never answers. Without the bound the only thing that
      // ends this is the platform's request timeout, which reaches the operator
      // as a blank page rather than as a sentence.
      fetchImpl: (async (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        })) as unknown as typeof fetch,
    });

    const error = await refusal(() => extractor.extract(request));

    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /timed out/);
    assert.equal(error.details?.name, 'lease_term');
    assert.equal(error.details?.timeoutMs, 20);
  });

  it('reports a failed call as unavailable, with the status and no key', async () => {
    const fetcher = fakeFetch(() => new Response('nope', { status: 500 }));
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    const error = await refusal(() => extractor.extract(request));

    assert.equal(error.code, 'unavailable');
    assert.equal(error.details?.status, 500);
    assert.equal(JSON.stringify(error.details).includes('sk-test'), false);
  });

  it('refuses a reply that is not JSON, without quoting it back', async () => {
    const fetcher = fakeFetch(() => reply('הסעיף אינו ברור'));
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    const error = await refusal(() => extractor.extract(request));

    assert.equal(error.code, 'unavailable');
    // The reply is the lease's own words coming back. An error body is one more
    // place they must not land, so the text is not in the details.
    assert.equal(JSON.stringify(error.details ?? {}).includes('הסעיף'), false);
  });

  it('refuses an array or a bare value, which are JSON and are not an object', async () => {
    const fetcher = fakeFetch(() => reply('[1,2]'));
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    const error = await refusal(() => extractor.extract(request));

    assert.equal(error.code, 'unavailable');
  });

  it('names a truncated reply as truncated, not as malformed', async () => {
    const fetcher = fakeFetch(() => reply('{"term":', 'length'));
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    const error = await refusal(() => extractor.extract(request));

    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /truncated/);
  });

  it('treats a declining model as a reply, never as JSON', async () => {
    const fetcher = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { refusal: 'לא אוכל', content: null } }],
          }),
          { status: 200 },
        ),
    );
    const extractor = createOpenAiExtractor({
      apiKey: 'sk-test',
      fetchImpl: fetcher.impl,
    });

    const error = await refusal(() => extractor.extract(request));

    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /declined/);
  });

  it('refuses every call when no key is configured, and says so at boot', async () => {
    const extractor = createUnconfiguredExtractor();

    const error = await refusal(() => extractor.extract(request));

    // An empty object here would write a lease with no fields and look exactly
    // like a lease that says nothing about its own term.
    assert.equal(error.code, 'unavailable');
    assert.equal(extractor.describe(), 'unconfigured');
  });

  it('records what it was asked, so a caller can be tested on what it sent', async () => {
    const extractor = createFakeExtractor(() => ({ ok: true }));

    await extractor.extract(request);

    assert.equal(extractor.calls.length, 1);
    assert.equal(extractor.calls[0]?.input, request.input);
  });
});
