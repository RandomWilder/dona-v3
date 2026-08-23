import {
  createHash,
  randomBytes,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';

// promisify resolves to scrypt's 3-argument overload; we need the one that
// takes cost parameters, so the signature is spelled out.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

// Chosen for a container with 512MB and a handful of operators: ~16MB and
// ~100ms per verification. Raising these later is safe — every record carries
// the parameters it was written with.
const defaultCost: ScryptCost = { N: 16384, r: 8, p: 1 };
const keyLength = 64;
const saltLength = 16;

export const sessionTtlMs = 12 * 60 * 60 * 1000;
export const minPasswordLength = 12;
const maxFailedAttempts = 5;
const attemptWindowMs = 15 * 60 * 1000;

export interface Operator {
  id: string;
  email: string;
}

export interface Session {
  token: string;
  operator: Operator;
  expiresAt: Date;
}

export interface AuthOptions {
  clock?: Clock;
}

// Every failure the login form can produce is this one, by design: unknown
// email, wrong password, throttled account and malformed input must be
// indistinguishable from outside. See SPEC-staff.md.
function rejected(): KernelError {
  return new KernelError('not_allowed', 'invalid credentials');
}

export async function hashPassword(
  password: string,
  cost: ScryptCost = defaultCost,
): Promise<string> {
  const salt = randomBytes(saltLength);
  const derived = await derive(password, salt, cost);
  return `scrypt$N=${cost.N},r=${cost.r},p=${cost.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// Parameters come out of the record being checked, never out of today's
// configuration — that is what makes raising the cost a non-event.
export async function verifyPassword(
  password: string,
  record: string,
): Promise<boolean> {
  const parsed = parseRecord(record);
  if (!parsed) {
    return false;
  }
  const derived = await derive(password, parsed.salt, parsed.cost);
  if (derived.length !== parsed.hash.length) {
    return false;
  }
  return timingSafeEqual(derived, parsed.hash);
}

function parseRecord(
  record: string,
): { cost: ScryptCost; salt: Buffer; hash: Buffer } | null {
  const parts = record.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') {
    return null;
  }
  const cost: Record<string, number> = {};
  for (const pair of parts[1].split(',')) {
    const [name, value] = pair.split('=');
    const parsed = Number(value);
    if (!name || !Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }
    cost[name] = parsed;
  }
  if (!cost.N || !cost.r || !cost.p) {
    return null;
  }
  return {
    cost: { N: cost.N, r: cost.r, p: cost.p },
    salt: Buffer.from(parts[2], 'hex'),
    hash: Buffer.from(parts[3], 'hex'),
  };
}

function derive(
  password: string,
  salt: Buffer,
  cost: ScryptCost,
): Promise<Buffer> {
  return scryptAsync(password, salt, keyLength, {
    N: cost.N,
    r: cost.r,
    p: cost.p,
    // scrypt's memory guard is sized for the defaults; N*r*128 needs headroom.
    maxmem: 256 * cost.N * cost.r,
  });
}

// Verified against when no operator matches, so an unknown email costs the same
// as a wrong password. Built once at module load, from a value no one knows.
const dummyRecord = hashPassword(randomBytes(32).toString('hex'));

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0 || !trimmed.includes('@') || trimmed.length > 320) {
    throw new KernelError('invalid', 'email is invalid');
  }
  return trimmed;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface StaffAuth {
  createOperator(input: { email: string; password: string }): Promise<Operator>;
  login(email: string, password: string): Promise<Session>;
  logout(token: string): Promise<void>;
  readSession(token: string): Promise<Session | null>;
  findByEmail(email: string): Promise<Operator | null>;
}

export function createStaffAuth(
  pool: Pool,
  options: AuthOptions = {},
): StaffAuth {
  const clock = options.clock ?? systemClock;

  async function findByEmail(email: string): Promise<Operator | null> {
    const found = await pool.query<{ id: string; email: string }>(
      'SELECT id, email FROM staff_operators WHERE email = $1',
      [normalizeEmail(email)],
    );
    return found.rows[0] ?? null;
  }

  return {
    findByEmail,

    async createOperator(input) {
      const email = normalizeEmail(input.email);
      if (input.password.length < minPasswordLength) {
        throw new KernelError(
          'invalid',
          `password must be at least ${minPasswordLength} characters`,
        );
      }
      const id = newId(clock);
      const passwordHash = await hashPassword(input.password);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO staff_operators (id, email, password_hash, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [id, email, passwordHash, clock.now()],
      );
      if (inserted.rows.length === 0) {
        throw new KernelError('conflict', 'email already exists');
      }
      return { id, email };
    },

    async login(email, password) {
      let normalized: string;
      try {
        normalized = normalizeEmail(email);
      } catch {
        // Malformed input still costs a verification, and still says nothing.
        await verifyPassword(password, await dummyRecord);
        throw rejected();
      }
      const now = clock.now();
      const windowStart = new Date(now.getTime() - attemptWindowMs);

      const recent = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM staff_login_attempts WHERE email = $1 AND at > $2',
        [normalized, windowStart],
      );
      if (Number(recent.rows[0]?.count ?? '0') >= maxFailedAttempts) {
        throw rejected();
      }

      const found = await pool.query<{
        id: string;
        email: string;
        password_hash: string;
      }>(
        'SELECT id, email, password_hash FROM staff_operators WHERE email = $1',
        [normalized],
      );
      const row = found.rows[0];
      const matched = await verifyPassword(
        password,
        row?.password_hash ?? (await dummyRecord),
      );
      if (!row || !matched) {
        await pool.query(
          'INSERT INTO staff_login_attempts (id, email, at) VALUES ($1, $2, $3)',
          [newId(clock), normalized, now],
        );
        throw rejected();
      }

      await pool.query('DELETE FROM staff_login_attempts WHERE email = $1', [
        normalized,
      ]);
      await pool.query('DELETE FROM staff_sessions WHERE expires_at <= $1', [
        now,
      ]);

      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(now.getTime() + sessionTtlMs);
      await pool.query(
        `INSERT INTO staff_sessions (token_hash, operator_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [tokenHash(token), row.id, now, expiresAt],
      );
      return {
        token,
        operator: { id: row.id, email: row.email },
        expiresAt,
      };
    },

    async logout(token) {
      await pool.query('DELETE FROM staff_sessions WHERE token_hash = $1', [
        tokenHash(token),
      ]);
    },

    async readSession(token) {
      const now = clock.now();
      const found = await pool.query<{
        operator_id: string;
        email: string;
        expires_at: Date;
      }>(
        `SELECT s.operator_id, o.email, s.expires_at
           FROM staff_sessions s
           JOIN staff_operators o ON o.id = s.operator_id
          WHERE s.token_hash = $1 AND s.expires_at > $2`,
        [tokenHash(token), now],
      );
      const row = found.rows[0];
      if (!row) {
        // A miss is also the moment to clear anything that has aged out.
        await pool.query('DELETE FROM staff_sessions WHERE expires_at <= $1', [
          now,
        ]);
        return null;
      }
      return {
        token,
        operator: { id: row.operator_id, email: row.email },
        expiresAt: new Date(row.expires_at),
      };
    },
  };
}
