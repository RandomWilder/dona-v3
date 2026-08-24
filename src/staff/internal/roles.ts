import { KernelError } from '../../kernel/errors.ts';

// Who an operator is allowed to be. Ordered most to least powerful, which is
// also the order the matrix below reads in.
export const staffRoles = ['admin', 'operator', 'viewer'] as const;
export type StaffRole = (typeof staffRoles)[number];

// What an operator is allowed to do. `administer` has no command behind it yet
// — named now so the first one to arrive has an answer waiting instead of
// inventing a fourth role.
export const capabilities = ['read', 'mutate', 'administer'] as const;
export type Capability = (typeof capabilities)[number];

// Code and not a config row, deliberately — a stated exception to SPEC.md's
// "policies are data". Rule 4 governs tunables; an access-control matrix a
// database write could widen is a privilege-escalation path. Changing who may
// mutate costs a deploy and leaves a diff.
const matrix: Record<StaffRole, readonly Capability[]> = {
  admin: ['read', 'mutate', 'administer'],
  operator: ['read', 'mutate'],
  viewer: ['read'],
};

export function permits(role: StaffRole, capability: Capability): boolean {
  return matrix[role].includes(capability);
}

// The refusal every guarded command leaves by. `not_allowed` and nothing about
// which capability was missing: an operator learns what they may do from the
// board, not from probing commands.
export function requireCapability(
  role: StaffRole,
  capability: Capability,
): void {
  if (!permits(role, capability)) {
    throw new KernelError('not_allowed', 'role does not permit this command');
  }
}

// Validation at the edge, and here rather than in the kernel for the reason
// slice 7.1 drew that line: the kernel holds the shape of a value, never a
// domain word. Exact match only — 'Admin' is a typo, not a role.
export function validRole(value: unknown, field = 'role'): StaffRole {
  if (
    typeof value !== 'string' ||
    !(staffRoles as readonly string[]).includes(value)
  ) {
    throw new KernelError(
      'invalid',
      `${field} must be one of ${staffRoles.join(', ')}`,
    );
  }
  return value as StaffRole;
}
