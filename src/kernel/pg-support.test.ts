import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KernelError } from './errors.ts';
import { migratedPoolOrNull } from './pg-support.ts';

// Port 1 is never a Postgres: the connection is refused immediately, so these
// tests prove the guard without waiting on a timeout.
const unreachable = 'postgres://dona:dona@127.0.0.1:1/dona';

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  work: () => Promise<T>,
): Promise<T> {
  const previous = new Map(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  const apply = (values: Map<string, string | undefined>): void => {
    for (const [key, value] of values) {
      // Assigning undefined would store the string 'undefined'; only delete
      // actually unsets a variable.
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  apply(new Map(Object.entries(vars)));
  try {
    return await work();
  } finally {
    apply(previous);
  }
}

describe('pg-support', () => {
  it('skips locally when the database is unreachable', async () => {
    const pool = await withEnv(
      { DATABASE_URL: unreachable, REQUIRE_POSTGRES: undefined },
      migratedPoolOrNull,
    );

    assert.equal(pool, null);
  });

  it('fails loudly when REQUIRE_POSTGRES=1 and it cannot connect', async () => {
    await withEnv(
      { DATABASE_URL: unreachable, REQUIRE_POSTGRES: '1' },
      async () => {
        await assert.rejects(migratedPoolOrNull(), (error: unknown) => {
          assert.ok(error instanceof KernelError);
          assert.equal(error.code, 'unavailable');
          return true;
        });
      },
    );
  });
});
