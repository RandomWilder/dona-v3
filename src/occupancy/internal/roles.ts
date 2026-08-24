import { KernelError } from '../../kernel/errors.ts';

// Pure: no clock, no pool, no database — as identity's phone.ts and
// portfolio's keys.ts are. See SPEC-occupancy.md.

// The lease has three kinds of party, not two. The role lives on the
// tenancy↔person link rather than on the person, so one man can guarantee his
// daughter's flat while renting his own.
export const occupancyRoles = ['tenant', 'billed', 'guarantor'] as const;
export type OccupancyRole = (typeof occupancyRoles)[number];

// What a party may reach. Week 3's document retrieval is scoped by this value
// rather than re-deciding the question, which is what makes "a guarantor does
// not get a tenant's access" a seam instead of a convention.
export type TenancyAccess = 'resident' | 'party';

export function validRole(value: unknown): OccupancyRole {
  if (!occupancyRoles.includes(value as OccupancyRole)) {
    throw new KernelError('invalid', 'unknown role', { role: value });
  }
  return value as OccupancyRole;
}

// Being on the hook for the money is not the same as living behind the door,
// and only the second earns the entry code, the fault history and the lease.
// So a `billed` party who is not also a tenant is a `party`, exactly as the
// guarantor is.
export function tenancyAccess(roles: readonly OccupancyRole[]): TenancyAccess {
  return roles.includes('tenant') ? 'resident' : 'party';
}

// Sorted and deduplicated, so a resolution reads the same however the parties
// were recorded.
export function sortRoles(roles: readonly OccupancyRole[]): OccupancyRole[] {
  const unique = [...new Set(roles)];
  return unique.sort(
    (a, b) => occupancyRoles.indexOf(a) - occupancyRoles.indexOf(b),
  );
}
