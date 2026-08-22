// The shape of one golden case, and of one answer from whatever is being
// graded. Assertions are on behaviour — which tool ran, was a clause cited,
// was the answer refused — not on final-text equality, so cases survive the
// agent's wording changing (PIPELINE.md §6).

export interface CaseInput {
  message: string;
}

export interface Expectation {
  /** The answer must decline rather than invent an unknown fact. */
  refuses: boolean;
  /** The answer must ground itself in at least one lease/policy clause. */
  citesClause: boolean;
  /** The tool the turn must call, or null for "no tool". */
  tool: string | null;
  /** Substrings the answer must contain. */
  contains: string[];
}

export interface GoldenCase {
  id: string;
  title: string;
  input: CaseInput;
  expect: Expectation;
}

/** One turn produced by the thing under test. */
export interface AgentTurn {
  text: string;
  refused: boolean;
  citations: string[];
  toolCalls: string[];
}

export type Subject = (input: CaseInput) => Promise<AgentTurn>;

// Golden cases are data files edited by hand, so they are an edge: validate
// them (SPEC.md, "validate all inputs at the edge") rather than trusting the
// JSON to match the type.
export function parseCase(raw: unknown, source: string): GoldenCase {
  const fail = (why: string): never => {
    throw new Error(`invalid golden case in ${source}: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null) return fail('not an object');
  const value = raw as Record<string, unknown>;

  const text = (key: string): string =>
    typeof value[key] === 'string' && value[key].length > 0
      ? value[key]
      : fail(`${key} must be a non-empty string`);

  const input = value.input as Record<string, unknown> | undefined;
  if (typeof input?.message !== 'string' || input.message.length === 0) {
    fail('input.message must be a non-empty string');
  }

  const expect = value.expect as Record<string, unknown> | undefined;
  if (typeof expect !== 'object' || expect === null) fail('expect is missing');
  const flag = (key: string): boolean =>
    typeof expect?.[key] === 'boolean'
      ? (expect[key] as boolean)
      : fail(`expect.${key} must be a boolean`);
  if (expect?.tool !== null && typeof expect?.tool !== 'string') {
    fail('expect.tool must be a string or null');
  }
  if (
    !Array.isArray(expect?.contains) ||
    expect.contains.some((item) => typeof item !== 'string')
  ) {
    fail('expect.contains must be an array of strings');
  }

  return {
    id: text('id'),
    title: text('title'),
    input: { message: (input as Record<string, string>).message },
    expect: {
      refuses: flag('refuses'),
      citesClause: flag('citesClause'),
      tool: (expect?.tool ?? null) as string | null,
      contains: expect?.contains as string[],
    },
  };
}
