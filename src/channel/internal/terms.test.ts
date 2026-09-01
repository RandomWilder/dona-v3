import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agreement, agrees, contentTerms } from './terms.ts';

// Pure unit tests. This file is the refusal rule, so these are the tests that
// say what the rule *is* — the contract tests only prove it is wired in.

describe('content terms', () => {
  it('keeps a word that begins with a particle letter as itself', () => {
    // The first cut of this file stripped in a loop, so `שעות` became `עות` and
    // `המשרד` became `שרד`. The letters are ordinary letters as well as
    // particles, and every question about opening hours matched nothing.
    assert.ok(contentTerms('שעות')[0]?.includes('שעות'));
    assert.ok(contentTerms('המשרד')[0]?.includes('המשרד'));
  });

  it('offers the word without its particle as an alternative', () => {
    assert.ok(contentTerms('בדירה')[0]?.includes('דירה'));
    assert.ok(contentTerms('ולהסכם')[0]?.includes('הסכם'));
  });

  it('drops a function word, and one wearing a particle', () => {
    assert.deepEqual(contentTerms('מה זה של'), []);
    // `באילו` is `אילו` with a particle, and asks as little as `אילו` does.
    assert.deepEqual(contentTerms('באילו'), []);
  });
});

describe('agreement', () => {
  it('reads a word wearing a particle as the same word', () => {
    assert.ok(agrees('מה גובה דמי השכירות?', 'דמי השכירות החודשיים הם 4,850.'));
    assert.ok(agrees('מתי נמסרת הדירה?', 'הדירה תימסר לשוכר במועד המסירה.'));
  });

  it('misses a plural formed by a suffix, and that is the known cost', () => {
    // `דירות` is `דירה` with the ה replaced, which a common-prefix test cannot
    // span. Named here rather than left to be discovered: the rule's failures
    // are refusals, and a refusal sends a tenant to a person. Closing this by
    // normalizing ות→ה was considered and rejected — it would make `שעה` match
    // `שעות המנוחה`, and the measured effect is a question about a technician's
    // arrival grounded in the lease's quiet-hours rule.
    assert.equal(
      agrees('כמה דירות יש בבניין?', 'הדירה נמסרת כשהיא פנויה.'),
      false,
    );
  });

  it('does not let a short word swallow a long one it has nothing to do with', () => {
    // Measured: at a three-character bar `מדי` — as in `מדי חודש בחודשו` — ran
    // into `המדינה`, and a question about who won the state cup was grounded in
    // the clause stating the rent.
    assert.equal(
      agrees('מי זכה בגביע המדינה?', 'דמי השכירות ישולמו מדי חודש בחודשו.'),
      false,
    );
  });

  it('refuses a question that asks nothing at all', () => {
    assert.equal(agrees('מה?', 'דמי השכירות החודשיים הם 4,850.'), false);
    assert.equal(agrees('   ', 'טקסט כלשהו'), false);
  });

  it('counts how much of the question a passage uses, not how similar it is', () => {
    // The number that makes two corpora comparable where a cosine distance is
    // not: it is measured in the question's own words.
    const question = 'באילו שעות המשרד פתוח?';
    const policy = 'המשרד פתוח בימים ראשון עד חמישי, שעות הפעילות מתפרסמות.';
    const lease = 'שעות המנוחה במתחם הן בין 22:00 ל-07:00.';
    assert.equal(agreement(question, policy), 3);
    assert.equal(agreement(question, lease), 1);
    assert.ok(agreement(question, policy) > agreement(question, lease));
  });
});
