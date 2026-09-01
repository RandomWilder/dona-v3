import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentTurn,
  type GoldenCase,
  parseCase,
  type RankedHit,
  type Retriever,
  type Subject,
} from './case.ts';
import {
  formatReport,
  gradeRetrieval,
  loadCases,
  rankOf,
  runCases,
} from './runner.ts';
import { placeholderSubject } from './subject.ts';

const silent: Subject = async (): Promise<AgentTurn> => ({
  text: '',
  refused: false,
  citations: [],
  toolCalls: [],
});

const behavioural = (cases: GoldenCase[]) =>
  cases.filter((golden) => !golden.retrieval);
const retrieval = (cases: GoldenCase[]) =>
  cases.filter((golden) => golden.retrieval);

// A retriever that returns the refs it is given, in order, at plausible
// distances. Nothing here reaches a database or a provider: what these tests
// pin is the *grading*, and what real retrieval returns is the measurement's
// job rather than the suite's.
function hitsOf(refs: (string | null)[]): RankedHit[] {
  return refs.map((clauseRef, index) => ({
    clauseRef,
    distance: 0.35 + index * 0.02,
  }));
}

function retrieverOf(refs: (string | null)[]): Retriever {
  return async (): Promise<RankedHit[]> => hitsOf(refs);
}

describe('golden set', () => {
  it('every behavioural case passes, and retrieval cases skip without a retriever', async () => {
    const cases = await loadCases();
    assert.ok(cases.length >= 3, 'the gate needs cases to be a gate');

    const report = await runCases(cases, { answer: placeholderSubject });

    assert.equal(report.failed, 0, formatReport(report));
    assert.equal(report.passed, behavioural(cases).length);
    // Skipped is reported, never counted as passed: a run that graded nothing
    // must not read like a run that graded everything.
    assert.equal(report.skipped, retrieval(cases).length);
    assert.equal(report.total, cases.length);
  });

  it('fails a subject that misses the expectations', async () => {
    const cases = await loadCases();
    const report = await runCases(cases, { answer: silent });

    assert.equal(report.passed, 0);
    assert.equal(report.failed, behavioural(cases).length);
    assert.ok(
      report.results
        .filter((result) => !result.skipped)
        .every((result) => result.failures.length > 0),
      'every failed case must say why',
    );
  });

  it('fails a case whose subject throws instead of crashing the run', async () => {
    const cases = await loadCases();
    const report = await runCases(cases, {
      answer: async () => {
        throw new Error('model timeout');
      },
    });

    assert.equal(report.failed, behavioural(cases).length);
    assert.match(report.results[0]?.failures[0] ?? '', /model timeout/);
  });

  it('grades the retrieval cases when a retriever is wired', async () => {
    const cases = await loadCases();
    const ranking = retrieval(cases);
    assert.ok(ranking.length >= 2, 'the ranking ratchet needs its two cases');

    // Every expected clause first, which beats any ratchet.
    const report = await runCases(ranking, {
      answer: placeholderSubject,
      retrieve: async (input) => {
        const golden = ranking.find(
          (item) => item.input.message === input.message,
        );
        return retrieverOf([golden?.retrieval?.expectRef ?? null])(input);
      },
    });

    assert.equal(report.skipped, 0);
    assert.equal(report.failed, 0, formatReport(report));
  });
});

describe('the ranking ratchet', () => {
  const golden: GoldenCase = {
    id: 'r',
    title: 'r',
    input: { message: 'מה גובה דמי השכירות?' },
    retrieval: { expectRef: 'נספח א׳ §10', rankAtMost: 3 },
  };

  it('counts a rank from one, so the first hit is rank 1', () => {
    assert.equal(rankOf(hitsOf([null, 'נספח א׳ §10']), 'נספח א׳ §10'), 2);
    assert.equal(rankOf(hitsOf([]), 'נספח א׳ §10'), 0);
  });

  it('passes at the ratchet and fails one place worse', () => {
    assert.deepEqual(
      gradeRetrieval(golden, hitsOf([null, '§7', 'נספח א׳ §10'])),
      [],
    );
    const worse = gradeRetrieval(
      golden,
      hitsOf([null, '§7', 'נספח ב׳ §1', 'נספח א׳ §10']),
    );
    assert.equal(worse.length, 1);
    assert.match(worse[0] ?? '', /ranked 4, worse than the ratchet at 3/);
  });

  // Absent and badly-placed are different failures, and reading them as one
  // hides which of the two happened.
  it('says a clause is absent rather than calling it badly ranked', () => {
    const missing = gradeRetrieval(golden, hitsOf([null, '§7', 'נספח ב׳ §1']));
    assert.match(missing[0] ?? '', /did not come back at all in 3 hits/);
  });
});

describe('golden case validation', () => {
  it('rejects a malformed case', () => {
    assert.throws(
      () => parseCase({ id: 'x', title: 'y', input: {} }, 'bad.json'),
      /input.message/,
    );
  });

  it('rejects a case that is both kinds, or neither', () => {
    const input = { message: 'מה?' };
    assert.throws(
      () =>
        parseCase(
          {
            id: 'x',
            title: 'y',
            input,
            expect: { refuses: true, citesClause: false, tool: null, contains: [] },
            retrieval: { expectRef: 'a', rankAtMost: 1 },
          },
          'both.json',
        ),
      /exactly one of expect or retrieval/,
    );
    assert.throws(
      () => parseCase({ id: 'x', title: 'y', input }, 'neither.json'),
      /exactly one of expect or retrieval/,
    );
  });

  it('rejects a rank that is not a position in a list', () => {
    const base = { id: 'x', title: 'y', input: { message: 'מה?' } };
    assert.throws(
      () =>
        parseCase(
          { ...base, retrieval: { expectRef: 'a', rankAtMost: 0 } },
          'zero.json',
        ),
      /rankAtMost/,
    );
    assert.throws(
      () =>
        parseCase(
          { ...base, retrieval: { expectRef: '', rankAtMost: 1 } },
          'empty.json',
        ),
      /expectRef/,
    );
  });
});
