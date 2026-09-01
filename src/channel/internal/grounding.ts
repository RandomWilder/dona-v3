import type { Catalog } from '../../catalog/contract.ts';
import { KernelError } from '../../kernel/errors.ts';
import type { Occupancy } from '../../occupancy/contract.ts';
import { agreement } from './terms.ts';

// Where an answer is allowed to come from, and in what order. See
// SPEC-channel.md, "Grounding": **this tenancy's lease → company policy →
// refuse**, and the refusal is a real answer rather than a fallback.
//
// It lives here because it composes two modules. `occupancy` searches one
// tenancy's clauses and stops; `catalog` searches org-wide policy and stops;
// ordering them is neither one's business, and SPEC.md's map puts `channel`
// above both. Week 4's agent reaches for this as a tool rather than calling the
// two searches itself -- which is what stops the ordering rule from being
// re-decided inside a prompt.

export type GroundingSource = 'lease' | 'policy' | 'none';

/** One passage an answer may be grounded in, and cite. */
export interface GroundedHit {
  chunkId: string;
  /** What a citation says: `נספח א׳ §10`, or `נוהל פנייה למשרד § שעות פעילות`. */
  ref: string;
  heading: string | null;
  text: string;
  /** Where in the document, for a lease. Absent for policy, which has no pages. */
  pageFrom?: number;
  pageTo?: number;
  distance: number;
}

export interface Grounding {
  source: GroundingSource;
  /** In rank order, and empty when `source` is `none`. */
  hits: GroundedHit[];
  /**
   * True exactly when nothing grounded the question. Named rather than left for
   * a caller to infer from an empty list: "no hits" and "hand this to a person"
   * are the same fact here, and a caller that reads only one of them is a
   * caller that answers anyway.
   */
  escalate: boolean;
}

export interface GroundQuestionInput {
  tenancyId: string;
  question: string;
}

export interface Channel {
  groundQuestion(input: GroundQuestionInput): Promise<Grounding>;
}

export interface ChannelDeps {
  occupancy: Occupancy;
  catalog: Catalog;
}

export function createChannel(deps: ChannelDeps): Channel {
  return {
    async groundQuestion(input) {
      const question =
        typeof input?.question === 'string' ? input.question.trim() : '';
      if (question.length === 0) {
        throw new KernelError('invalid', 'a question is required');
      }
      const tenancyId =
        typeof input?.tenancyId === 'string' ? input.tenancyId.trim() : '';
      if (tenancyId.length === 0) {
        throw new KernelError('invalid', 'tenancyId is required');
      }

      // The lease first, and **not by score**. Two corpora embedded by one
      // model still produce distances that are not comparable across them: a
      // policy written in plain Hebrew out-scores a clause written in contract
      // Hebrew on a plainly-worded question, every time, without being the
      // better answer.
      //
      // What is comparable is how much of the question each corpus actually
      // uses — a count of the question's own words, in the question's own units.
      // The lease wins ties, so a tenant's own contract outranks a company
      // procedure unless the procedure answers *strictly more* of what was
      // asked. Measured: `באילו שעות המשרד פתוח?` finds one word in the lease's
      // quiet-hours rule and three in the office-hours policy.
      const clauses = await deps.occupancy.searchClauses({
        tenancyId,
        query: question,
      });
      const fromLease = rank(
        clauses
          .filter((hit) => hit.clauseRef !== null)
          .map((hit) => ({
            agreement: agreement(question, hit.text),
            hit: {
              chunkId: hit.chunkId,
              ref: hit.clauseRef as string,
              heading: hit.heading,
              text: hit.text,
              pageFrom: hit.pageFrom,
              pageTo: hit.pageTo,
              distance: hit.distance,
            },
          })),
      );

      const sections = await deps.catalog.searchGuidance({ query: question });
      const fromPolicy = rank(
        sections.map((hit) => ({
          agreement: agreement(question, hit.text),
          hit: {
            chunkId: hit.chunkId,
            ref: hit.headingRef,
            heading: hit.heading,
            text: hit.text,
            distance: hit.distance,
          },
        })),
      );

      if (fromLease.best > 0 && fromLease.best >= fromPolicy.best) {
        return { source: 'lease', hits: fromLease.hits, escalate: false };
      }
      if (fromPolicy.best > 0) {
        return { source: 'policy', hits: fromPolicy.hits, escalate: false };
      }

      // The third answer, and a real one. Nothing in this tenancy's lease and
      // nothing in the company's policy speaks to the question, so the honest
      // reply is that we do not know and a person should. No hits are returned
      // at all -- a caller handed the near-misses would put them in a prompt,
      // and a model given eight irrelevant clauses and asked to be helpful
      // invents the ninth.
      return { source: 'none', hits: [], escalate: true };
    },
  };
}

// The passages that speak to the question, kept in the order retrieval returned
// them, and how much the best of them agrees.
//
// Order is retrieval's and not agreement's on purpose: agreement decides *which*
// passages may be cited, and similarity decides which of them a reader is shown
// first. Sorting by a count of shared words would put a passage that repeats the
// question above the one that answers it.
function rank<T extends { text: string }>(
  scored: { agreement: number; hit: T }[],
): { hits: T[]; best: number } {
  const kept = scored.filter((row) => row.agreement > 0);
  return {
    hits: kept.map((row) => row.hit),
    best: kept.reduce((most, row) => Math.max(most, row.agreement), 0),
  };
}
