import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentTurn,
  type GoldenCase,
  type GroundedAnswer,
  type Grounder,
  parseCase,
  type RankedHit,
  type Retriever,
  type Subject,
} from './case.ts';
import {
  formatReport,
  gradeGrounding,
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
  cases.filter((golden) => !golden.retrieval && !golden.grounding);
const retrieval = (cases: GoldenCase[]) =>
  cases.filter((golden) => golden.retrieval);
const grounded = (cases: GoldenCase[]) =>
  cases.filter((golden) => golden.grounding);
// Both kinds need a database and a key, so both skip together.
const needsCorpus = (cases: GoldenCase[]) =>
  cases.filter((golden) => golden.retrieval || golden.grounding);

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
  it('every behavioural case passes, and corpus cases skip without a corpus', async () => {
    const cases = await loadCases();
    assert.ok(cases.length >= 3, 'the gate needs cases to be a gate');

    const report = await runCases(cases, { answer: placeholderSubject });

    assert.equal(report.failed, 0, formatReport(report));
    assert.equal(report.passed, behavioural(cases).length);
    // Skipped is reported, never counted as passed: a run that graded nothing
    // must not read like a run that graded everything.
    assert.equal(report.skipped, needsCorpus(cases).length);
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
      /exactly one of expect, retrieval or grounding/,
    );
    assert.throws(
      () => parseCase({ id: 'x', title: 'y', input }, 'neither.json'),
      /exactly one of expect, retrieval or grounding/,
    );
    // Three kinds now, so two of any pair is still two.
    assert.throws(
      () =>
        parseCase(
          {
            id: 'x',
            title: 'y',
            input,
            retrieval: { expectRef: 'a', rankAtMost: 1 },
            grounding: { expectSource: 'none' },
          },
          'both-again.json',
        ),
      /exactly one of expect, retrieval or grounding/,
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

function answered(
  source: GroundedAnswer['source'],
  refs: string[],
): GroundedAnswer {
  return {
    source,
    hits: refs.map((ref) => ({ ref })),
    escalate: source === 'none',
  };
}

const grounderOf = (answer: GroundedAnswer): Grounder => async () => answer;

describe('grounding cases', () => {
  it('grades where the answer was allowed to come from', async () => {
    const cases = await loadCases();
    const refusals = grounded(cases).filter(
      (golden) => golden.grounding?.expectSource === 'none',
    );
    assert.ok(refusals.length >= 1, 'the slice bar needs a refusal case');

    const passing = await runCases(refusals, {
      answer: placeholderSubject,
      ground: grounderOf(answered('none', [])),
    });
    assert.equal(passing.failed, 0, formatReport(passing));

    // A system that answers a question it has no grounding for is the failure
    // the whole slice exists to prevent, so the gate has to be able to see it.
    const inventing = await runCases(refusals, {
      answer: placeholderSubject,
      ground: grounderOf(answered('lease', ['נספח א׳ §10'])),
    });
    assert.equal(inventing.passed, 0);
    assert.match(
      inventing.results[0]?.failures[0] ?? '',
      /expected the answer to come from none, got lease/,
    );
  });

  it('catches a refusal that hands back its near-misses anyway', () => {
    const refusal: GoldenCase = {
      id: 'x',
      title: 'y',
      input: { message: 'מה?' },
      grounding: { expectSource: 'none' },
    };
    const failures = gradeGrounding(refusal, {
      source: 'none',
      hits: [{ ref: 'נספח א׳ §10' }],
      escalate: true,
    });
    assert.match(failures.join(' '), /returned 1 passages to cite anyway/);
  });

  it('catches escalate and source disagreeing', () => {
    const refusal: GoldenCase = {
      id: 'x',
      title: 'y',
      input: { message: 'מה?' },
      grounding: { expectSource: 'none' },
    };
    const failures = gradeGrounding(refusal, {
      source: 'none',
      hits: [],
      escalate: false,
    });
    assert.match(failures.join(' '), /escalate=false disagrees/);
  });

  it('refuses a case that expects a citation on a refusal', () => {
    assert.throws(
      () =>
        parseCase(
          {
            id: 'x',
            title: 'y',
            input: { message: 'מה?' },
            grounding: { expectSource: 'none', expectRef: 'נספח א׳ §10' },
          },
          'bad.json',
        ),
      /a refusal case cannot expect a citation/,
    );
  });
});
