import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AgentTurn, parseCase, type Subject } from './case.ts';
import { formatReport, loadCases, runCases } from './runner.ts';
import { placeholderSubject } from './subject.ts';

const silent: Subject = async (): Promise<AgentTurn> => ({
  text: '',
  refused: false,
  citations: [],
  toolCalls: [],
});

describe('golden set', () => {
  it('every case in evals/golden passes', async () => {
    const cases = await loadCases();
    assert.ok(cases.length >= 3, 'the gate needs cases to be a gate');

    const report = await runCases(cases, placeholderSubject);

    assert.equal(report.failed, 0, formatReport(report));
    assert.equal(report.passed, cases.length);
  });

  // The point of the slice: a gate that cannot fail is not a gate. Grade a
  // subject that answers nothing and the run must come back red.
  it('fails a subject that misses the expectations', async () => {
    const report = await runCases(await loadCases(), silent);

    assert.equal(report.passed, 0);
    assert.equal(report.failed, report.total);
    assert.ok(
      report.results.every((result) => result.failures.length > 0),
      'every failed case must say why',
    );
  });

  it('fails a case whose subject throws instead of crashing the run', async () => {
    const report = await runCases(await loadCases(), async () => {
      throw new Error('model timeout');
    });

    assert.equal(report.failed, report.total);
    assert.match(report.results[0]?.failures[0] ?? '', /model timeout/);
  });
});

describe('golden case validation', () => {
  it('rejects a malformed case', () => {
    assert.throws(
      () => parseCase({ id: 'x', title: 'y', input: {} }, 'bad.json'),
      /input.message/,
    );
  });
});
