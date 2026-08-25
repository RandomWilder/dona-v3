import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilities, permits, staffRoles } from './roles.ts';

// The read guard, stated honestly. Every read in `queries.ts` calls
// `requireCapability(role, 'read')` — and today no role can fail it, because
// all three hold `read`. That is not coverage hiding a bug; it is the shape of
// the matrix, and this test pins it so the fact stays visible.
describe('the read guard', () => {
  it('is passed by every role that exists today', () => {
    for (const role of staffRoles) {
      assert.equal(permits(role, 'read'), true, role);
    }
  });

  it('is the reason a fourth role cannot silently open the views', () => {
    // If someone adds a role, `permits` is where its answer to `read` is
    // decided — one place, and the views are already asking. The failing case
    // this guard exists for is a role that does not hold `read`; there is no
    // such role yet, so `queries.ts` has no reachable refusal to test end to
    // end. Recorded in SPEC-staff.md rather than dressed up as tested.
    const answers = staffRoles.map((role) =>
      capabilities.filter((capability) => permits(role, capability)),
    );
    assert.deepEqual(answers, [
      ['read', 'mutate', 'administer'],
      ['read', 'mutate'],
      ['read'],
    ]);
  });
});
