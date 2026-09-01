import { migratedPoolOrNull } from '../src/kernel/pg-support.ts';
import type { RankedHit } from './case.ts';
import { buildCorpus, embeddingsConfigured } from './corpus.ts';
import { mockLeaseRefs } from './fixtures/mock-lease.ts';

// The instrument, and not the gate. `npm run evals` decides whether a merge is
// allowed; this prints the numbers that decide what 14.1b should *do*.
//
// It answers the three questions slice 14.1a exists to answer:
//
//   1. Does the fixture reproduce 12.2's defect at all? A corpus that ranks
//      cleanly measures nothing, and finding that out is a finding.
//   2. Are the same one or two chunks universal attractors — do they win
//      questions on unrelated topics?
//   3. **Does distance separate at all?** Is there any threshold that admits
//      the answering clause and rejects the front page? A refusal rule is a
//      threshold, so 14.1b's central bullet lives or dies on this number.
//
// Output is markdown, to be read once and pasted into
// tasks/evidence/day-14-ranking.md.

interface Probe {
  question: string;
  /** The clause that answers it, as chunkLease spells the reference. */
  expect: string;
  /** True for the two questions slice 12.2 measured on the real lease. */
  golden?: boolean;
}

const probes: Probe[] = [
  {
    question: 'מה גובה דמי השכירות?',
    expect: mockLeaseRefs.rent,
    golden: true,
  },
  {
    question: 'עד מתי חוזה השכירות?',
    expect: mockLeaseRefs.term,
    golden: true,
  },
  { question: 'מי אחראי על תיקון נזילה בדוד?', expect: mockLeaseRefs.repairs },
  { question: 'איזו ערבות צריך להפקיד?', expect: mockLeaseRefs.securities },
  { question: 'האם מותר להחזיק כלב בדירה?', expect: 'נספח ב׳ §3' },
  { question: 'מה שעות המנוחה במתחם?', expect: 'נספח ב׳ §1' },
];

// Slice 14.1b's own probes: questions whose answers are **not in this lease**.
// The refusal rule is designed from these, because a rule tuned only on
// questions that have answers is a rule that has never been asked to say no.
interface GroundingProbe {
  question: string;
  /** Where the answer should come from, decided by reading the corpora. */
  want: 'lease' | 'policy' | 'none';
  why: string;
}

const groundingProbes: GroundingProbe[] = [
  {
    question: 'מה גובה דמי השכירות?',
    want: 'lease',
    why: 'נספח א׳ §10 states it',
  },
  {
    question: 'האם מותר להחזיק כלב בדירה?',
    want: 'lease',
    why: 'נספח ב׳ §3 states it',
  },
  {
    question: 'באילו שעות המשרד פתוח?',
    want: 'policy',
    why: 'the lease says nothing about the office; the guidance does',
  },
  {
    question: 'כיצד מדווחים על תקלה שאינה דחופה?',
    want: 'policy',
    why: 'a reporting procedure is ours, not the contract\'s',
  },
  {
    question: 'האם צריך לתאם מראש כניסה לדירה לצורך תיקון?',
    // Written expecting `policy`, and corrected by the instrument rather than
    // by an argument: §7.4 says in as many words that the landlord may enter to
    // carry out a repair *after coordinating in advance*. The lease does answer
    // this, the guidance adds the procedure, and lease-first is right.
    want: 'lease',
    why: '§7.4 states it; the guidance adds the procedure and does not replace it',
  },
  {
    question: 'באיזו שעה בדיוק יגיע הטכנאי מחר?',
    // Also corrected by the instrument. Written as the refusal case golden 002
    // carries, and the guidance turns out to answer it: `נקבע לה חלון זמן ולא
    // שעה מדויקת` — a window is set, not an exact hour. A grounded answer
    // saying so is better than a refusal, and it is the answer a tenant wants.
    want: 'policy',
    why: 'the entry procedure says a window is set and an exact hour is not',
  },
  {
    question: 'כמה עולה מנוי לחדר הכושר במתחם השכן?',
    want: 'none',
    why: 'about another building, and about a price nobody wrote down',
  },
  {
    question: 'מי זכה בגביע המדינה בכדורגל?',
    want: 'none',
    why: 'nothing to do with a tenancy at all',
  },
  {
    question: 'מה מזג האוויר צפוי להיות בסוף השבוע?',
    want: 'none',
    why: 'a second refusal, so the rule is not proved by one sentence',
  },
];

const round = (value: number) => value.toFixed(3);
const label = (ref: string | null) => ref ?? '— (front matter)';

const pool = await migratedPoolOrNull();
if (!pool) {
  console.error('no database — npm run db:up');
  process.exit(1);
}
if (!embeddingsConfigured()) {
  console.error('no OPENAI_API_KEY — the measurement needs a real embedder');
  process.exit(1);
}

const corpus = await buildCorpus(pool);
// Both numbers, because since 14.1b they differ: a cover page and a bare
// heading are stored and not embedded, so a corpus of 19 chunks is a corpus of
// 16 findable ones and one number for both would overstate the search.
console.log(
  `# Ranking measurement — mock lease, ${corpus.chunks} chunks, ` +
    `${corpus.indexed} indexed · ${corpus.sections} policy sections\n`,
);

interface Measured extends Probe {
  hits: RankedHit[];
  rank: number;
  expectedDistance: number | null;
  frontRank: number;
  frontDistance: number | null;
}

const measured: Measured[] = [];
for (const probe of probes) {
  const hits = await corpus.search(probe.question);
  const at = hits.findIndex((hit) => hit.clauseRef === probe.expect);
  const front = hits.findIndex((hit) => hit.clauseRef === null);
  measured.push({
    ...probe,
    hits,
    rank: at + 1,
    expectedDistance: at >= 0 ? (hits[at]?.distance ?? null) : null,
    frontRank: front + 1,
    frontDistance: front >= 0 ? (hits[front]?.distance ?? null) : null,
  });
}

console.log('## Every result set, in order\n');
for (const row of measured) {
  const tag = row.golden ? ' *(12.2 golden question)*' : '';
  console.log(`### \`${row.question}\`${tag}`);
  console.log(`Answering clause: \`${row.expect}\` — **rank ${row.rank || '—'}**\n`);
  console.log('| # | clause | distance |');
  console.log('|---|---|---|');
  row.hits.forEach((hit, index) => {
    const mark = hit.clauseRef === row.expect ? ' ✅' : '';
    console.log(
      `| ${index + 1} | \`${label(hit.clauseRef)}\`${mark} | ${round(hit.distance)} |`,
    );
  });
  console.log('');
}

// Question 2: the attractor. A chunk that wins questions on unrelated topics is
// the thing 12.2 suspected, and "appears in the top 3 of N of 6 probes" is what
// that looks like as a number.
console.log('## Universal attractors\n');
const topThree = new Map<string, number>();
for (const row of measured) {
  for (const hit of row.hits.slice(0, 3)) {
    const key = label(hit.clauseRef);
    topThree.set(key, (topThree.get(key) ?? 0) + 1);
  }
}
console.log(`| chunk | top-3 appearances (of ${measured.length} probes) |`);
console.log('|---|---|');
for (const [ref, count] of [...topThree].sort((a, b) => b[1] - a[1])) {
  console.log(`| \`${ref}\` | ${count} |`);
}
const frontIn = measured.filter((row) => row.frontRank > 0 && row.frontRank <= 3);
console.log(
  `\nThe front page (\`clauseRef: null\`) is in the top 3 for **${frontIn.length} of ${measured.length}** probes.\n`,
);

// Question 3: separation. The refusal rule is a threshold, so this is the table
// 14.1b is designed from.
console.log('## Does distance separate?\n');
console.log('| question | answering clause | front page | gap |');
console.log('|---|---|---|---|');
for (const row of measured) {
  const gap =
    row.expectedDistance !== null && row.frontDistance !== null
      ? round(row.frontDistance - row.expectedDistance)
      : '—';
  console.log(
    `| \`${row.question}\` | ${row.expectedDistance === null ? 'absent' : round(row.expectedDistance)} |` +
      ` ${row.frontDistance === null ? 'absent' : round(row.frontDistance)} | ${gap} |`,
  );
}

const all = measured.flatMap((row) => row.hits.map((hit) => hit.distance));
const answered = measured
  .map((row) => row.expectedDistance)
  .filter((value): value is number => value !== null);
const worstAnswer = answered.length > 0 ? Math.max(...answered) : Number.NaN;
const others = measured.flatMap((row) =>
  row.hits
    .filter((hit) => hit.clauseRef !== row.expect)
    .map((hit) => hit.distance),
);
const bestWrong = others.length > 0 ? Math.min(...others) : Number.NaN;

console.log(
  `\nAll distances span \`${round(Math.min(...all))}\`–\`${round(Math.max(...all))}\`.`,
);
console.log(
  `Worst answering clause: \`${round(worstAnswer)}\` · best non-answer: \`${round(bestWrong)}\`.`,
);
// The one sentence 14.1b needs. A single threshold admitting every right answer
// and rejecting every wrong one exists only if these two do not overlap.
console.log(
  worstAnswer < bestWrong
    ? `\n**A separating threshold exists**, anywhere in \`${round(bestWrong)}\`–\`${round(worstAnswer)}\`.`
    : '\n**No single distance threshold separates right from wrong here** — the worst answering clause scores worse than the best non-answer. A refusal rule cannot be a bare distance cutoff.',
);

// Slice 14.1b: the refusal. Printed after the distances on purpose -- the table
// above is why this is not a threshold, and this is what replaced it.
console.log('\n## Grounding: lease → policy → refuse\n');
console.log('| question | wanted | got | cites | ok |');
console.log('|---|---|---|---|---|');
let grounded = 0;
for (const probe of groundingProbes) {
  const answer = await corpus.grounding(probe.question);
  const ok = answer.source === probe.want;
  if (ok) grounded += 1;
  const cites = answer.hits[0]?.ref ?? '—';
  console.log(
    `| \`${probe.question}\` | ${probe.want} | ${answer.source} |` +
      ` \`${cites}\` | ${ok ? '✅' : '✘'} |`,
  );
}
console.log(
  `\n**${grounded} of ${groundingProbes.length}** probes were grounded where they should be.`,
);
for (const probe of groundingProbes) {
  console.log(`- \`${probe.question}\` — ${probe.want}: ${probe.why}`);
}

console.log('\n## Ratchet values\n');
console.log('The rank each golden question achieves today:\n');
for (const row of measured.filter((probe) => probe.golden)) {
  console.log(`- \`${row.question}\` → \`${row.expect}\` — rank **${row.rank}**`);
}

await pool.end();
