import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import {
  capabilities,
  permits,
  requireCapability,
  staffRoles,
  validRole,
} from './roles.ts';

describe('staff roles', () => {
  it('knows exactly the three ROADMAP week 2 names', () => {
    assert.deepEqual([...staffRoles], ['admin', 'operator', 'viewer']);
  });

  // Written as the whole grid rather than as the interesting cases, so a fourth
  // capability cannot be added without deciding every role's answer to it.
  describe('the matrix', () => {
    const expected: Record<string, Record<string, boolean>> = {
      admin: { read: true, mutate: true, administer: true },
      operator: { read: true, mutate: true, administer: false },
      viewer: { read: true, mutate: false, administer: false },
    };

    for (const role of staffRoles) {
      for (const capability of capabilities) {
        const verb = expected[role][capability] ? 'permits' : 'refuses';
        it(`${role} ${verb} ${capability}`, () => {
          assert.equal(
            permits(role, capability),
            expected[role][capability],
            `${role} / ${capability}`,
          );
        });
      }
    }

    it('covers every role and capability that exists', () => {
      assert.deepEqual(Object.keys(expected), [...staffRoles]);
      for (const role of staffRoles) {
        assert.deepEqual(Object.keys(expected[role]), [...capabilities]);
      }
    });
  });

  describe('requireCapability', () => {
    it('returns quietly when the role permits it', () => {
      assert.equal(requireCapability('operator', 'mutate'), undefined);
    });

    it('throws not_allowed when it does not', () => {
      assert.throws(
        () => requireCapability('viewer', 'mutate'),
        (error) => {
          const kernel = error as KernelError;
          assert.equal(kernel.code, 'not_allowed');
          // Which capability was missing is deliberately not in the message.
          assert.ok(!kernel.message.includes('mutate'));
          return true;
        },
      );
    });
  });

  describe('validRole', () => {
    it('accepts each of them', () => {
      for (const role of staffRoles) {
        assert.equal(validRole(role), role);
      }
    });

    it('refuses anything else', () => {
      const invalid = (error: KernelError) => error.code === 'invalid';
      for (const value of [
        'Admin',
        'ADMIN',
        ' admin',
        'superuser',
        'staff',
        '',
        undefined,
        null,
        1,
        {},
      ]) {
        assert.throws(() => validRole(value), invalid, String(value));
      }
    });
  });
});
