import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import {
  occupancyRoles,
  sortRoles,
  tenancyAccess,
  validRole,
} from './roles.ts';

describe('occupancy roles', () => {
  it('knows exactly the three the lease has', () => {
    assert.deepEqual([...occupancyRoles], ['tenant', 'billed', 'guarantor']);
  });

  describe('validRole', () => {
    it('accepts each of them', () => {
      for (const role of occupancyRoles) {
        assert.equal(validRole(role), role);
      }
    });

    it('refuses anything else', () => {
      const invalid = (error: KernelError) => error.code === 'invalid';
      for (const value of [
        'owner',
        'landlord',
        'Tenant',
        '',
        undefined,
        null,
        7,
      ]) {
        assert.throws(() => validRole(value), invalid);
      }
    });

    it('names the offending value in the details', () => {
      assert.throws(
        () => validRole('landlord'),
        (error: KernelError) => {
          assert.deepEqual(error.details, { role: 'landlord' });
          return true;
        },
      );
    });
  });

  describe('tenancyAccess', () => {
    // Living behind the door is what earns the entry code, the fault history
    // and the lease. Being on the hook for the money is not the same thing.
    it('makes a tenant a resident', () => {
      assert.equal(tenancyAccess(['tenant']), 'resident');
    });

    it('makes a tenant who also pays a resident', () => {
      assert.equal(tenancyAccess(['tenant', 'billed']), 'resident');
    });

    // The guarantor of the שטר חוב. He is a party to the tenancy and does not
    // live there, which is the whole reason the role is on the link.
    it('makes a guarantor a party and nothing more', () => {
      assert.equal(tenancyAccess(['guarantor']), 'party');
    });

    // The parent paying a student's rent.
    it('makes a billed party who does not live there a party', () => {
      assert.equal(tenancyAccess(['billed']), 'party');
    });

    it('makes a billed guarantor a party', () => {
      assert.equal(tenancyAccess(['billed', 'guarantor']), 'party');
    });

    it('treats no roles at all as a party, never as a resident', () => {
      assert.equal(tenancyAccess([]), 'party');
    });
  });

  describe('sortRoles', () => {
    it('reads the same however the parties were recorded', () => {
      assert.deepEqual(sortRoles(['billed', 'tenant']), ['tenant', 'billed']);
      assert.deepEqual(sortRoles(['tenant', 'billed']), ['tenant', 'billed']);
      assert.deepEqual(sortRoles(['guarantor', 'tenant', 'billed']), [
        'tenant',
        'billed',
        'guarantor',
      ]);
    });

    it('collapses a repeat', () => {
      assert.deepEqual(sortRoles(['tenant', 'tenant']), ['tenant']);
    });

    it('leaves an empty list empty', () => {
      assert.deepEqual(sortRoles([]), []);
    });
  });
});
