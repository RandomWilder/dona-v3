import { KernelError } from './errors.ts';

// Edge validation. Everything a caller can get wrong becomes `invalid` here,
// rather than a Postgres cast error surfacing as `unavailable` later.
//
// These hold no business logic — the kernel's rule. A validator that knows a
// domain vocabulary (portfolio's asset kinds, identity's person kinds) stays in
// its module; what lives here is only the shape of a value.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireText(
  value: unknown,
  field: string,
  max: number,
): string {
  if (typeof value !== 'string') {
    throw new KernelError('invalid', `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new KernelError('invalid', `${field} must be 1 to ${max} characters`);
  }
  return trimmed;
}

export function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, field, max);
}

export function validId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) {
    throw new KernelError('invalid', `${field} is not an id`);
  }
  return value;
}

// Audit inputs must survive a caller passing nonsense, since the audit entry is
// built before validation runs.
export function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
