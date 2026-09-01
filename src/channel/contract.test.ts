import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Catalog, GuidanceHit } from '../catalog/contract.ts';
import type { KernelError } from '../kernel/errors.ts';
import type { ClauseHit, Occupancy } from '../occupancy/contract.ts';
import { createChannel } from './contract.ts';

// Contract tests for the ordering rule. No database: the two modules this one
// composes are reached through their contracts, so the test states what they
// returned and asserts what `channel` did with it. What the real corpora
// actually return is measured by `npm run measure` and gated by the golden set.

function clause(ref: string | null, text: string, distance = 0.5): ClauseHit {
  return {
    chunkId: `chunk-${ref ?? 'none'}`,
    documentId: 'doc-1',
    clauseRef: ref,
    heading: null,
    pageFrom: 14,
    pageTo: 14,
    text,
    distance,
  };
}

function section(ref: string, text: string, distance = 0.4): GuidanceHit {
  return {
    chunkId: `section-${ref}`,
    documentId: 'guidance-1',
    title: 'נוהל פנייה למשרד',
    headingRef: ref,
    heading: ref.split(' § ')[1] ?? null,
    text,
    distance,
  };
}

function channelOver(clauses: ClauseHit[], sections: GuidanceHit[]) {
  const occupancy = {
    searchClauses: async () => clauses,
  } as unknown as Occupancy;
  const catalog = {
    searchGuidance: async () => sections,
  } as unknown as Catalog;
  return createChannel({ occupancy, catalog });
}

const tenancyId = '44444444-4444-4444-8444-444444444444';

describe('channel grounding', () => {
  it('answers from the lease and cites the clause', async () => {
    const channel = channelOver(
      [clause('נספח א׳ §10', 'דמי השכירות החודשיים בבסיס הם 4,850 ש"ח.')],
      [
        section(
          'נוהל פנייה למשרד § שעות פעילות',
          'המשרד פתוח בימים ראשון עד חמישי.',
        ),
      ],
    );
    const answer = await channel.groundQuestion({
      tenancyId,
      question: 'מה גובה דמי השכירות?',
    });
    assert.equal(answer.source, 'lease');
    assert.equal(answer.escalate, false);
    assert.equal(answer.hits[0]?.ref, 'נספח א׳ §10');
  });

  it('falls through to policy when the lease speaks to nothing asked', async () => {
    const channel = channelOver(
      [clause('נספח ב׳ §1', 'שעות המנוחה במתחם הן בין 22:00 ל-07:00.')],
      [
        section(
          'נוהל פנייה למשרד § שעות פעילות המשרד',
          'המשרד פתוח בימים ראשון עד חמישי בין 09:00 ל-17:00.',
        ),
      ],
    );
    const answer = await channel.groundQuestion({
      tenancyId,
      question: 'באילו שעות המשרד פתוח?',
    });
    // The lease shares one word with the question and the policy shares three.
    // Not a distance comparison — the two corpora's distances are not
    // comparable — but a count of the question's own words, which is.
    assert.equal(answer.source, 'policy');
    assert.equal(answer.hits[0]?.ref, 'נוהל פנייה למשרד § שעות פעילות המשרד');
  });

  it('gives the lease the tie, because it is the tenant own contract', async () => {
    const channel = channelOver(
      [clause('נספח ב׳ §3', 'החזקת בעלי חיים בדירה טעונה אישור מראש ובכתב.')],
      [
        section(
          'נוהל כניסה לדירה § תיאום מראש',
          'כניסה לדירה מתואמת מראש מול הדייר.',
        ),
      ],
    );
    const answer = await channel.groundQuestion({
      tenancyId,
      question: 'האם מותר להחזיק כלב בדירה?',
    });
    assert.equal(answer.source, 'lease');
    assert.equal(answer.hits[0]?.ref, 'נספח ב׳ §3');
  });

  it('refuses, and hands back nothing to cite anyway', async () => {
    const channel = channelOver(
      [clause('נספח א׳ §10', 'דמי השכירות החודשיים בבסיס הם 4,850 ש"ח.')],
      [
        section(
          'נוהל פנייה למשרד § שעות פעילות',
          'המשרד פתוח בימים ראשון עד חמישי.',
        ),
      ],
    );
    const answer = await channel.groundQuestion({
      tenancyId,
      question: 'מי זכה בגביע המדינה בכדורגל?',
    });
    assert.equal(answer.source, 'none');
    assert.equal(answer.escalate, true);
    // Not a shortened list: an empty one. A caller handed the near-misses would
    // put them in a prompt, and a model given eight irrelevant clauses and asked
    // to be helpful invents the ninth.
    assert.deepEqual(answer.hits, []);
  });

  it('never offers a passage nothing can cite', async () => {
    // Ingestion stopped embedding these in 14.1b, so this cannot arrive from a
    // freshly-read document. It can arrive from one indexed before that change,
    // and a citation is the whole product.
    const channel = channelOver(
      [
        clause(null, 'ישראל ישראלי, ת.ז. 039284715, דמי השכירות והדירה.', 0.1),
        clause('נספח א׳ §10', 'דמי השכירות החודשיים בבסיס הם 4,850 ש"ח.'),
      ],
      [],
    );
    const answer = await channel.groundQuestion({
      tenancyId,
      question: 'מה גובה דמי השכירות?',
    });
    assert.equal(answer.source, 'lease');
    assert.equal(answer.hits.length, 1);
    assert.equal(answer.hits[0]?.ref, 'נספח א׳ §10');
  });

  it('keeps the passages in the order retrieval returned them', async () => {
    // Agreement decides which passages may be cited; similarity decides which
    // one a reader is shown first. Sorting by shared words would put a passage
    // that repeats the question above the one that answers it.
    const channel = channelOver(
      [
        clause('נספח א׳ §10', 'דמי השכירות החודשיים בבסיס הם 4,850 ש"ח.', 0.3),
        clause(
          'נספח א׳ §12',
          'להבטחת התחייבויות השוכר בדבר דמי השכירות תופקד ערבות בנקאית.',
          0.6,
        ),
      ],
      [],
    );
    const answer = await channel.groundQuestion({
      tenancyId,
      question: 'מה גובה דמי השכירות?',
    });
    assert.deepEqual(
      answer.hits.map((hit) => hit.ref),
      ['נספח א׳ §10', 'נספח א׳ §12'],
    );
  });

  it('refuses an empty question and a missing tenancy rather than searching', async () => {
    const channel = channelOver([], []);
    await assert.rejects(
      channel.groundQuestion({ tenancyId, question: '   ' }),
      (error: KernelError) => error.code === 'invalid',
    );
    await assert.rejects(
      channel.groundQuestion({ tenancyId: '', question: 'מה גובה השכירות?' }),
      (error: KernelError) => error.code === 'invalid',
    );
  });
});
