// The shape of one golden case, and of one answer from whatever is being
// graded. Assertions are on behaviour — which tool ran, was a clause cited,
// was the answer refused — not on final-text equality, so cases survive the
// agent's wording changing (PIPELINE.md §6).
//
// There are two kinds of case, and a file is exactly one of them:
//
//   - a **behavioural** case, carrying `expect`, graded against an agent turn;
//   - a **retrieval** case, carrying `retrieval`, graded against the ordered
//     result set `searchClauses` returned for the question (slice 14.1a).
//
// The second kind exists because ranking is a measured defect rather than a
// suspicion, and a defect with no instrument is a feeling. See the ratchet
// below.

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

// A retrieval case asserts **where in the result set** the answering clause
// came back, and nothing else.
//
// `rankAtMost` is a **ratchet, not a target**. It is set to the rank retrieval
// achieves today, so the gate blocks a regression from the first commit while
// staying green — and the proof that a later ranking change is a fix is that
// the number goes *down*. `tasks/todo.md` states the rule this encodes: "a
// ranking change that does not move these is not a fix."
//
// Deliberately no assertion on distance. Provider embeddings are not
// bit-identical between runs, so a committed distance is a gate that fails for
// weather. Measured distances are observations and live in the evidence file.
export interface RetrievalExpectation {
  /** The clause reference that answers the question, as chunkLease spells it. */
  expectRef: string;
  /** 1-based. The expected clause must come back at this rank or better. */
  rankAtMost: number;
  /** Free text: where the number came from, so the file explains itself. */
  note?: string;
}

export interface GoldenCase {
  id: string;
  title: string;
  input: CaseInput;
  /** Present on a behavioural case. */
  expect?: Expectation;
  /** Present on a retrieval case. */
  retrieval?: RetrievalExpectation;
}

/** One turn produced by the thing under test. */
export interface AgentTurn {
  text: string;
  refused: boolean;
  citations: string[];
  toolCalls: string[];
}

/** One hit from the thing being ranked, in the order it came back. */
export interface RankedHit {
  clauseRef: string | null;
  distance: number;
}

export type Subject = (input: CaseInput) => Promise<AgentTurn>;
export type Retriever = (input: CaseInput) => Promise<RankedHit[]>;

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

  // Exactly one kind, checked before either is read. A file carrying both would
  // be graded twice against two different subjects; one carrying neither would
  // pass by asserting nothing, which is the failure mode a gate cannot have.
  const hasExpect = value.expect !== undefined;
  const hasRetrieval = value.retrieval !== undefined;
  if (hasExpect === hasRetrieval) {
    fail('a case must carry exactly one of expect or retrieval');
  }

  const id = text('id');
  const title = text('title');
  const message = (input as Record<string, string>).message;

  if (hasRetrieval) {
    return {
      id,
      title,
      input: { message },
      retrieval: parseRetrieval(value.retrieval, fail),
    };
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
    id,
    title,
    input: { message },
    expect: {
      refuses: flag('refuses'),
      citesClause: flag('citesClause'),
      tool: (expect?.tool ?? null) as string | null,
      contains: expect?.contains as string[],
    },
  };
}

function parseRetrieval(
  raw: unknown,
  fail: (why: string) => never,
): RetrievalExpectation {
  if (typeof raw !== 'object' || raw === null) {
    fail('retrieval must be an object');
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.expectRef !== 'string' || value.expectRef.length === 0) {
    fail('retrieval.expectRef must be a non-empty string');
  }
  // A rank is a position in a list, so it starts at 1. Zero would silently
  // assert something unsatisfiable and read as "top of the list".
  if (
    typeof value.rankAtMost !== 'number' ||
    !Number.isInteger(value.rankAtMost) ||
    value.rankAtMost < 1
  ) {
    fail('retrieval.rankAtMost must be an integer of at least 1');
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    fail('retrieval.note must be a string when present');
  }
  return {
    expectRef: value.expectRef,
    rankAtMost: value.rankAtMost,
    note: value.note as string | undefined,
  };
}
