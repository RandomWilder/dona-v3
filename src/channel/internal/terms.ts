// Whether a retrieved passage has anything to do with the question asked.
//
// This exists because slice 14.1a **measured a distance threshold out of the
// running**. Across six probes the worst answering clause scored `0.652` and the
// best non-answer `0.358`; removing the front-page attractor narrowed the
// overlap and did not close it. A refusal of the form *"refuse when nothing
// scores below T"* is therefore not buildable on cosine distance, and this file
// is the signal that replaces it.
//
// Pure: no clock, no pool, no network. As `occupancy/internal/clauses.ts` and
// `catalog/internal/guidance.ts` are, and for the same reason -- everything hard
// about the refusal rule is in here, which is why it is the piece a test can
// state a sentence to.
//
// **When it is wrong, it refuses.** Hebrew morphology is richer than any
// affix-stripping this file does, so a question and the clause that answers it
// can share a root and not a token -- and the answer will be a refusal. That is
// the direction the error is deliberately allowed to fall: a refusal sends a
// tenant to a human, and an invention sends them away satisfied and wrong.

// Function words. A question is mostly these, and a passage that shares only
// `של` with it shares nothing at all.
const stopwords = new Set([
  'מה',
  'מי',
  'האם',
  'איך',
  'כיצד',
  'מתי',
  'איפה',
  'היכן',
  'כמה',
  'איזה',
  'איזו',
  'אילו',
  'למה',
  'מדוע',
  'של',
  'את',
  'על',
  'אל',
  'עם',
  'אני',
  'אתה',
  'את',
  'הוא',
  'היא',
  'הם',
  'הן',
  'אנחנו',
  'זה',
  'זו',
  'זאת',
  'אלה',
  'יש',
  'אין',
  'לא',
  'כן',
  'אם',
  'כי',
  'או',
  'גם',
  'רק',
  'כל',
  'עוד',
  'אבל',
  'כדי',
  'אחרי',
  'לפני',
  'תוך',
  'בין',
  'לי',
  'לו',
  'לה',
  'להם',
  'שלי',
  'שלו',
  'שלה',
  'צריך',
  'צריכה',
  'אפשר',
  'מותר',
  'אסור',
  'רוצה',
  'עושים',
  'עושה',
  'קורה',
  'בדיוק',
  'בבקשה',
  'תודה',
  'שלום',
]);

// The single-letter particles Hebrew attaches to the front of a word: and, the,
// in, to, from, like, that.
//
// **Stripping is a candidate, never a commitment**, and the first cut of this
// file got that wrong: it removed leading particles in a loop, so `שעות` became
// `עות` and `המשרד` became `שרד`. The letters are ordinary letters as well as
// particles, and a word that begins with one is far more often just a word. So a
// token keeps its own spelling and *offers* the stripped form alongside it; two
// tokens agree if any of their forms do.
const prefixes = 'והבלמכש';

// Short enough to be a particle or a fragment rather than a subject.
const minimumTerm = 3;

// How much of two terms has to coincide before they are the same word, when
// they are not the same word. Four rather than three, and the difference was
// measured: at three, `מדי` — as in `מדי חודש בחודשו`, monthly — ran into
// `המדינה`, and a question about who won the state cup was grounded in the
// clause stating the rent. Three characters is a Hebrew root and also a
// perfectly ordinary short word, which is the whole problem with the shorter
// bar. At four, `דירה`/`דירות` still agree and `מדי`/`מדינה` do not.
const minimumShared = 4;

/** A word and the same word with its particles taken off, longest first. */
function forms(token: string): string[] {
  const all = [token];
  let word = token;
  // Two at most: `ובדירה` is `ו` + `ב` + a word, and a third would be reaching.
  for (let taken = 0; taken < 2; taken += 1) {
    const first = word[0];
    if (first === undefined || !prefixes.includes(first)) {
      break;
    }
    const rest = word.slice(1);
    if (rest.length < minimumTerm) {
      break;
    }
    all.push(rest);
    word = rest;
  }
  return all;
}

/**
 * The words in a sentence that carry its subject.
 *
 * Each term is kept as its forms — the word as written, and as it reads with a
 * particle taken off.
 */
export function contentTerms(text: string): string[][] {
  const terms: string[][] = [];
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const token = raw.trim().toLowerCase();
    if (token.length < minimumTerm) {
      continue;
    }
    const all = forms(token);
    // A stopword in any form is a stopword: `באילו` is `אילו` with a particle,
    // and it asks as little as `אילו` does.
    if (all.some((form) => stopwords.has(form))) {
      continue;
    }
    terms.push(all);
  }
  return terms;
}

/**
 * How many of the question's distinct content terms the passage actually uses.
 *
 * A count and not a score, and that is what makes it comparable **across two
 * different corpora** where a cosine distance is not: it is measured in the
 * question's own words, so a lease clause and a policy section can be asked the
 * same thing and answer in the same units.
 */
export function agreement(question: string, passage: string): number {
  const asked = contentTerms(question);
  if (asked.length === 0) {
    // A question made entirely of function words asks nothing this system can
    // ground an answer in. Refusing is the right answer to "מה?".
    return 0;
  }
  const found = contentTerms(passage);
  let matched = 0;
  for (const term of asked) {
    if (found.some((other) => shared(term, other))) {
      matched += 1;
    }
  }
  return matched;
}

/**
 * Whether a passage speaks to the question at all.
 *
 * The yes/no that decides whether an answer may be grounded in this passage or
 * whether the honest reply is "I do not know". Not a similarity and not a
 * threshold — see the note at the top of this file for why it cannot be one.
 */
export function agrees(question: string, passage: string): boolean {
  return agreement(question, passage) > 0;
}

// Two terms are the same word when one of their forms runs into one of the
// other's and they agree on a root's worth of characters. Inflection in Hebrew
// is mostly suffixes, so a common prefix is the cheap test that survives it.
function shared(a: string[], b: string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (left === right) {
        return true;
      }
      // Exact agreement is exact at any length; running-into is what needs the
      // longer bar, because that is the direction a short word swallows a long
      // one it has nothing to do with.
      const shorter = left.length <= right.length ? left : right;
      const longer = shorter === left ? right : left;
      if (shorter.length >= minimumShared && longer.startsWith(shorter)) {
        return true;
      }
    }
  }
  return false;
}
