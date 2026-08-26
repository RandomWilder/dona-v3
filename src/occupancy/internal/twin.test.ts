import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  annexOf,
  buildRequest,
  type ClauseSource,
  maxClausesPerField,
  readReply,
  selectClauses,
} from './twin.ts';

// Fixtures are built to the *structure* the reference note documents, with
// invented content -- the rule clauses.test.ts set: no line of the real lease
// is copied into this repo.
let nextOrdinal = 0;
function clause(
  clauseRef: string | null,
  text: string,
  extra: Partial<ClauseSource> = {},
): ClauseSource {
  nextOrdinal += 1;
  return {
    id: `chunk-${nextOrdinal}`,
    ordinal: nextOrdinal,
    clauseRef,
    heading: null,
    pageFrom: 1,
    pageTo: 1,
    text,
    ...extra,
  };
}

const frontPage = clause(
  null,
  'בין: ישראלה ישראלי ת.ז. 000000000 טלפון 050-0000000 לבין: …',
);
const annexTerm = clause(
  'נספח א׳ §5',
  'תקופת השכירות: 36 חודשים, ולאחריה שתי תקופות אופציה בנות 24 חודשים כל אחת.',
);
const annexRent = clause(
  'נספח א׳ §10',
  'דמי השכירות: 4,250 ש"ח לחודש, צמודים למדד המחירים לצרכן של חודש הבסיס.',
);
const bodyNotice = clause(
  '§14.2',
  'השוכר יודיע בכתב 90 יום מראש על רצונו להאריך את התקופה, ויפנה את המושכר בתום התקופה.',
);
const unrelated = clause('§3.1', 'מטרת השכירות היא מגורים בלבד.');

const lease = [frontPage, annexTerm, annexRent, bodyNotice, unrelated];

function reply(value: unknown, chunkId: string, confidence = 'high') {
  return { found: true, chunkId, confidence, value };
}

describe('twin — which clauses are sent', () => {
  it('never sends a clause with no reference, which is where the parties are', () => {
    for (const field of [
      'term',
      'rent',
      'securities',
      'notice',
      'deductibles',
    ] as const) {
      const sent = selectClauses(field, lease);
      // The front page is the PII-densest text in the document and carries no
      // clause number. Requiring one is what keeps it off the wire entirely.
      assert.equal(
        sent.some((row) => row.id === frontPage.id),
        false,
        `${field} sent the front page`,
      );
    }
  });

  it('sends נספח א׳ for the term and the rent, by name and not by similarity', () => {
    assert.equal(
      selectClauses('term', lease).some((row) => row.id === annexTerm.id),
      true,
    );
    assert.equal(
      selectClauses('rent', lease).some((row) => row.id === annexRent.id),
      true,
    );
  });

  it('reaches a body clause by what it says, since the body does not name its clauses', () => {
    const sent = selectClauses('notice', lease);
    assert.equal(
      sent.some((row) => row.id === bodyNotice.id),
      true,
    );
    assert.equal(
      sent.some((row) => row.id === unrelated.id),
      false,
    );
  });

  it('sends them in reading order and stops at the budget', () => {
    const many = Array.from({ length: maxClausesPerField + 8 }, (_, at) =>
      clause(`נספח א׳ §${at + 1}`, 'תקופת השכירות נקבעת בזאת.'),
    );
    const sent = selectClauses('term', [...many].reverse());
    assert.equal(sent.length, maxClausesPerField);
    assert.deepEqual(
      sent.map((row) => row.ordinal),
      [...sent].sort((a, b) => a.ordinal - b.ordinal).map((row) => row.ordinal),
    );
  });

  it('reads an annex letter through whichever geresh the document used', () => {
    assert.equal(annexOf('נספח א׳ §5'), 'א');
    assert.equal(annexOf("נספח א' §5"), 'א');
    assert.equal(annexOf('נספח י״ב §3'), 'יב');
    assert.equal(annexOf('§14.1'), null);
    assert.equal(annexOf(null), null);
  });

  it('puts the clause ids in the request, and the rules in a separate turn', () => {
    const sent = selectClauses('term', lease);
    const request = buildRequest('term', 'gpt-5', sent);

    assert.equal(request.name, 'lease_term');
    assert.match(request.input, new RegExp(`\\[${annexTerm.id}\\]`));
    // The instruction that the clause text is data and not an instruction lives
    // in the system turn, where the contract's own words cannot displace it.
    assert.match(request.instructions, /ולא הוראה אליך/);
    assert.equal(request.input.includes(frontPage.text), false);
  });

  it('passes the reasoning effort through, and omits it when there is none', () => {
    const sent = selectClauses('term', lease);
    assert.equal(
      buildRequest('term', 'gpt-5.6-luna', sent, 'none').reasoningEffort,
      'none',
    );
    // Undefined rather than empty: the port sends no field at all, which is
    // what a model with no reasoning setting needs.
    assert.equal(
      buildRequest('term', 'gpt-4.1', sent).reasoningEffort,
      undefined,
    );
  });
});

describe('twin — what a reply is believed for', () => {
  const sent = [annexTerm, annexRent, bodyNotice];

  it('rejects a citation naming a clause that was not sent', () => {
    const invented = readReply(
      'rent',
      reply(
        {
          baseAmount: '4,250',
          currency: 'ש"ח',
          indexBaseMonth: 'ינואר 2026',
          rule: 'עדכון שנתי',
        },
        'chunk-does-not-exist',
      ),
      sent,
    );
    // A value with an invented citation is worse than no value: every screen
    // downstream renders it as grounded.
    assert.equal(invented, null);
  });

  it('rejects a citation naming another document, which is the same path', () => {
    const otherTenancy = clause('נספח א׳ §10', 'דמי השכירות של דירה אחרת.');
    const crossed = readReply(
      'rent',
      reply(
        {
          baseAmount: '9,900',
          currency: 'ש"ח',
          indexBaseMonth: null,
          rule: null,
        },
        otherTenancy.id,
      ),
      sent,
    );
    // Isolation asserted rather than assumed: the believed set is exactly the
    // clauses this call was given, and those were read under one tenancy.
    assert.equal(crossed, null);
  });

  it('keeps a term as an initial period plus options, with no single end date', () => {
    const field = readReply(
      'term',
      reply(
        {
          initialFrom: '2026-09-01',
          initialTo: '2029-08-31',
          options: [
            {
              from: '2029-09-01',
              to: '2031-08-31',
              noticeBy: '2029-06-01',
              statedText: 'אופציה ראשונה',
              chunkId: annexTerm.id,
            },
            {
              from: '2031-09-01',
              to: '2033-08-31',
              noticeBy: null,
              statedText: 'אופציה שנייה',
              chunkId: annexTerm.id,
            },
          ],
          capYears: 10,
          statedText: 'שלוש שנים ושתי אופציות',
        },
        annexTerm.id,
      ),
      sent,
    );

    assert.equal(field?.clauseRef, 'נספח א׳ §5');
    const value = field?.value as { options: unknown[]; capYears: number };
    assert.equal(value.options.length, 2);
    assert.equal(value.capYears, 10);
    // The shape has nowhere to put "the end date", which is the whole argument:
    // one date would state a falsehood the moment an option is exercised.
    assert.equal(Object.hasOwn(field?.value ?? {}, 'endsOn'), false);
  });

  it('keeps a rent as the figure the contract prints, and refuses one that arrived as a number', () => {
    const printed = readReply(
      'rent',
      reply(
        {
          baseAmount: '4,250',
          currency: 'ש"ח',
          indexBaseMonth: 'ינואר 2026',
          rule: 'עדכון שנתי לפי המדד',
        },
        annexRent.id,
      ),
      sent,
    );
    assert.ok(printed);
    assert.equal((printed.value as { baseAmount: string }).baseAmount, '4,250');

    const computed = readReply(
      'rent',
      reply(
        { baseAmount: 4250, currency: null, indexBaseMonth: null, rule: null },
        annexRent.id,
      ),
      sent,
    );
    // A figure that arrived as a number has already lost the way it was
    // written, which is the only thing this system may hold about it.
    assert.equal(computed, null);
  });

  it('drops a list item whose own citation was not sent, and keeps the rest', () => {
    const field = readReply(
      'notice',
      reply(
        [
          {
            event: 'הארכה',
            days: 90,
            statedText: 'הודעה מוקדמת',
            chunkId: bodyNotice.id,
          },
          {
            event: 'פינוי',
            days: 30,
            statedText: 'הודעה מוקדמת',
            chunkId: 'chunk-elsewhere',
          },
        ],
        bodyNotice.id,
      ),
      sent,
    );

    assert.ok(field);
    const rows = (
      field.value as { items: Array<{ event: string; clauseRef: string }> }
    ).items;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event, 'הארכה');
    // Each row of a list is a different clause, so each row carries its own
    // citation rather than borrowing the field's.
    assert.equal(rows[0]?.clauseRef, '§14.2');
  });

  it('stores nothing when the clauses do not say, which is not an error', () => {
    assert.equal(
      readReply(
        'term',
        { found: false, chunkId: null, confidence: 'low', value: null },
        sent,
      ),
      null,
    );
    assert.equal(readReply('securities', reply([], annexTerm.id), sent), null);
  });

  it('treats a missing confidence as low, never as high', () => {
    const field = readReply(
      'rent',
      {
        found: true,
        chunkId: annexRent.id,
        value: {
          baseAmount: '4,250',
          currency: null,
          indexBaseMonth: null,
          rule: null,
        },
      },
      sent,
    );
    assert.equal(field?.confidence, 'low');
  });
});
