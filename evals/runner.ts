import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentTurn,
  type GoldenCase,
  parseCase,
  type RankedHit,
  type Retriever,
  type Subject,
} from './case.ts';

export const goldenDir = fileURLToPath(new URL('golden/', import.meta.url));

export interface CaseResult {
  id: string;
  title: string;
  passed: boolean;
  /** True when nothing was graded — see `Subjects.retrieve`. */
  skipped: boolean;
  failures: string[];
}

export interface Report {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: CaseResult[];
}

// What the cases are run against. `answer` grades behavioural cases; `retrieve`
// grades retrieval ones and is optional because it needs a database and an
// embedding key, which a clean clone has neither of. Absent, retrieval cases
// **skip** rather than pass — and `run.ts` is where REQUIRE_EMBEDDINGS turns
// that skip back into a failure, exactly as REQUIRE_POSTGRES does for the
// durability suite (src/kernel/pg-support.ts).
export interface Subjects {
  answer: Subject;
  retrieve?: Retriever;
}

export async function loadCases(dir = goldenDir): Promise<GoldenCase[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  files.sort();
  const cases: GoldenCase[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), 'utf8');
    cases.push(parseCase(JSON.parse(raw), file));
  }
  return cases;
}

/** Every way this turn missed the case's expectations; empty means it passed. */
export function gradeTurn(golden: GoldenCase, turn: AgentTurn): string[] {
  const failures: string[] = [];
  const expect = golden.expect;
  if (!expect) return ['not a behavioural case'];

  if (turn.refused !== expect.refuses) {
    failures.push(`expected refuses=${expect.refuses}, got ${turn.refused}`);
  }
  const cited = turn.citations.length > 0;
  if (cited !== expect.citesClause) {
    failures.push(`expected citesClause=${expect.citesClause}, got ${cited}`);
  }
  if (expect.tool === null) {
    if (turn.toolCalls.length > 0) {
      failures.push(`expected no tool call, got ${turn.toolCalls.join(', ')}`);
    }
  } else if (!turn.toolCalls.includes(expect.tool)) {
    failures.push(
      `expected tool ${expect.tool}, got ${turn.toolCalls.join(', ') || 'none'}`,
    );
  }
  for (const needle of expect.contains) {
    if (!turn.text.includes(needle)) {
      failures.push(`expected the answer to contain "${needle}"`);
    }
  }

  return failures;
}

/** Where the answering clause came back, or 0 when it did not come back. */
export function rankOf(hits: RankedHit[], expectRef: string): number {
  return hits.findIndex((hit) => hit.clauseRef === expectRef) + 1;
}

/** The ranking grade: a position in the result set, never a distance. */
export function gradeRetrieval(
  golden: GoldenCase,
  hits: RankedHit[],
): string[] {
  const retrieval = golden.retrieval;
  if (!retrieval) return ['not a retrieval case'];

  const rank = rankOf(hits, retrieval.expectRef);
  if (rank === 0) {
    // Distinguished from "ranked too low" on purpose: a clause that is absent
    // from the result set entirely is a different failure from one that is
    // present and badly placed, and reading them as the same hides which.
    return [
      `${retrieval.expectRef} did not come back at all in ${hits.length} hits` +
        ` (got ${hits.map((hit) => hit.clauseRef ?? '—').join(', ') || 'none'})`,
    ];
  }
  if (rank > retrieval.rankAtMost) {
    return [
      `${retrieval.expectRef} ranked ${rank}, worse than the ratchet at ${retrieval.rankAtMost}`,
    ];
  }
  return [];
}

export async function runCases(
  cases: GoldenCase[],
  subjects: Subjects,
): Promise<Report> {
  const results: CaseResult[] = [];
  for (const golden of cases) {
    if (golden.retrieval && !subjects.retrieve) {
      results.push({
        id: golden.id,
        title: golden.title,
        passed: false,
        skipped: true,
        failures: [],
      });
      continue;
    }

    // A subject that throws is a failed case, not a crashed run: one broken
    // case must never hide the verdict on the rest.
    let failures: string[];
    try {
      failures = golden.retrieval
        ? gradeRetrieval(
            golden,
            await (subjects.retrieve as Retriever)(golden.input),
          )
        : gradeTurn(golden, await subjects.answer(golden.input));
    } catch (error) {
      failures = [
        `subject threw: ${error instanceof Error ? error.message : 'unknown'}`,
      ];
    }
    results.push({
      id: golden.id,
      title: golden.title,
      passed: failures.length === 0,
      skipped: false,
      failures,
    });
  }

  const graded = results.filter((result) => !result.skipped);
  const passed = graded.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    failed: graded.length - passed,
    skipped: results.length - graded.length,
    results,
  };
}

export function formatReport(report: Report): string {
  const lines = report.results.map((result) => {
    if (result.skipped) return `  ○ ${result.id} (skipped)`;
    return result.passed
      ? `  ✔ ${result.id}`
      : `  ✘ ${result.id}\n${result.failures.map((why) => `      ${why}`).join('\n')}`;
  });
  // The skipped count is printed even when it is zero, so a run that quietly
  // graded nothing cannot look like a run that graded everything.
  lines.push(
    `golden set: ${report.passed}/${report.total} passed, ` +
      `${report.failed} failed, ${report.skipped} skipped`,
  );
  return lines.join('\n');
}
