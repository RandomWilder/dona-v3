import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentTurn, type GoldenCase, parseCase, type Subject } from './case.ts';

export const goldenDir = fileURLToPath(new URL('golden/', import.meta.url));

export interface CaseResult {
  id: string;
  title: string;
  passed: boolean;
  failures: string[];
}

export interface Report {
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
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
  const { expect } = golden;

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

export async function runCases(
  cases: GoldenCase[],
  subject: Subject,
): Promise<Report> {
  const results: CaseResult[] = [];
  for (const golden of cases) {
    // A subject that throws is a failed case, not a crashed run: one broken
    // case must never hide the verdict on the rest.
    let failures: string[];
    try {
      failures = gradeTurn(golden, await subject(golden.input));
    } catch (error) {
      failures = [
        `subject threw: ${error instanceof Error ? error.message : 'unknown'}`,
      ];
    }
    results.push({
      id: golden.id,
      title: golden.title,
      passed: failures.length === 0,
      failures,
    });
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

export function formatReport(report: Report): string {
  const lines = report.results.map((result) =>
    result.passed
      ? `  ✔ ${result.id}`
      : `  ✘ ${result.id}\n${result.failures.map((why) => `      ${why}`).join('\n')}`,
  );
  lines.push(
    `golden set: ${report.passed}/${report.total} passed, ${report.failed} failed`,
  );
  return lines.join('\n');
}
