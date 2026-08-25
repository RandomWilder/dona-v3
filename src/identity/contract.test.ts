import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { fixedClock } from '../kernel/clock.ts';
import type { KernelError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../kernel/pg-support.ts';
import { type Actor, createIdentity } from './contract.ts';

// Contract tests: every command goes through contract.ts. The pool is used only
// to *inspect* what the commands left behind, never to shortcut one.
const actor: Actor = { kind: 'agent', id: 'contract-test' };

// The database persists between runs, so every test invents its own number.
function uniquePhone(): {
  dashed: string;
  local: string;
  national: string;
  bare: string;
} {
  const digits = newId().replace(/\D/g, '').slice(-7).padStart(7, '0');
  const local = `050${digits}`;
  return {
    dashed: `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`,
    local,
    national: `+972${local.slice(1)}`,
    bare: `972${local.slice(1)}`,
  };
}

async function withPool(
  t: { skip(reason: string): void },
  work: (pool: Pool) => Promise<void>,
): Promise<void> {
  const pool = await migratedPoolOrNull();
  if (!pool) {
    t.skip(skipReason);
    return;
  }
  try {
    await work(pool);
  } finally {
    await pool.end();
  }
}

describe('identity contract', () => {
  // The headline of the slice: three spellings, one person.
  it('resolves every format of one number to the same person', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const phone = uniquePhone();

      const person = await identity.addPerson(
        {
          intentKey: `test:${newId()}`,
          displayName: 'רות לוי',
          kinds: ['tenant'],
        },
        actor,
      );
      await identity.addPhone(
        { personId: person.id, phone: phone.dashed },
        actor,
      );

      for (const spelling of [
        phone.dashed,
        phone.local,
        phone.national,
        phone.bare,
      ]) {
        const found = await identity.findByPhone(spelling);
        assert.equal(found?.id, person.id, `resolving ${spelling}`);
      }
    });
  });

  it('returns the first result for a repeated intent key', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const intentKey = `test:${newId()}`;
      const displayName = `intent-${newId()}`;

      const first = await identity.addPerson(
        { intentKey, displayName, kinds: ['tenant'] },
        actor,
      );
      const second = await identity.addPerson(
        { intentKey, displayName, kinds: ['tenant'] },
        actor,
      );

      assert.deepEqual(second, first);
      const rows = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM identity_people WHERE display_name = $1',
        [displayName],
      );
      assert.equal(rows.rows[0]?.count, '1');
    });
  });

  it('stores a person as several kinds at once, deduped', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const phone = uniquePhone();

      const person = await identity.addPerson(
        {
          intentKey: `test:${newId()}`,
          displayName: 'יוסי — שרברב ודייר',
          kinds: ['vendor', 'tenant', 'tenant'],
          language: 'en',
        },
        actor,
      );
      await identity.addPhone(
        { personId: person.id, phone: phone.local },
        actor,
      );

      assert.deepEqual(person.kinds, ['tenant', 'vendor']);
      const found = await identity.findByPhone(phone.national);
      assert.deepEqual(found?.kinds, ['tenant', 'vendor']);
      assert.equal(found?.language, 'en');
    });
  });

  it('accepts the same phone twice and refuses it for a second person', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const phone = uniquePhone();
      const one = await identity.addPerson(
        {
          intentKey: `test:${newId()}`,
          displayName: 'דייר א',
          kinds: ['tenant'],
        },
        actor,
      );
      const two = await identity.addPerson(
        {
          intentKey: `test:${newId()}`,
          displayName: 'דייר ב',
          kinds: ['tenant'],
        },
        actor,
      );

      const first = await identity.addPhone(
        { personId: one.id, phone: phone.dashed },
        actor,
      );
      // The same intent, written differently — idempotent, not a second row.
      const again = await identity.addPhone(
        { personId: one.id, phone: phone.national },
        actor,
      );
      assert.deepEqual(again, first);

      await assert.rejects(
        identity.addPhone({ personId: two.id, phone: phone.bare }, actor),
        (error: KernelError) => error.code === 'conflict',
      );
      // The refusal changed nothing: the number still resolves to its owner.
      assert.equal((await identity.findByPhone(phone.local))?.id, one.id);
    });
  });

  it('refuses a phone for a person who does not exist', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      await assert.rejects(
        identity.addPhone(
          { personId: newId(), phone: uniquePhone().local },
          actor,
        ),
        (error: KernelError) => error.code === 'not_found',
      );
    });
  });

  it('rejects what a caller can get wrong, at the edge', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const person = await identity.addPerson(
        {
          intentKey: `test:${newId()}`,
          displayName: 'תקין',
          kinds: ['tenant'],
        },
        actor,
      );
      const invalid = (error: KernelError) => error.code === 'invalid';

      await assert.rejects(
        identity.addPerson(
          {
            intentKey: `test:${newId()}`,
            displayName: '   ',
            kinds: ['tenant'],
          },
          actor,
        ),
        invalid,
      );
      await assert.rejects(
        identity.addPerson(
          {
            intentKey: `test:${newId()}`,
            displayName: 'מישהו',
            kinds: ['landlord' as 'tenant'],
          },
          actor,
        ),
        invalid,
      );
      await assert.rejects(
        identity.addPerson(
          { intentKey: '', displayName: 'מישהו', kinds: ['tenant'] },
          actor,
        ),
        invalid,
      );
      await assert.rejects(
        identity.addPhone({ personId: person.id, phone: '501234567' }, actor),
        invalid,
      );
      // A personId that is not an id must not reach Postgres as a cast error.
      await assert.rejects(
        identity.addPhone(
          { personId: 'not-an-id', phone: uniquePhone().local },
          actor,
        ),
        invalid,
      );
      await assert.rejects(identity.findByPhone('not a phone'), invalid);
    });
  });

  it('answers null for a number nobody holds', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      assert.equal(await identity.findByPhone(uniquePhone().national), null);
    });
  });

  it('names a handful of ids in one query, and skips one that is unknown', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const made = [];
      for (const displayName of ['דנה', 'יוסי', 'רותי']) {
        made.push(
          await identity.addPerson(
            { intentKey: newId(), displayName, kinds: ['tenant'] },
            actor,
          ),
        );
      }
      const missing = newId();
      const found = await identity.getPeople([made[0].id, missing, made[2].id]);

      // A dangling party leaves the others on screen rather than failing the
      // page — the whole reason a miss is an absence and not an error.
      assert.equal(found.length, 2);
      assert.deepEqual(found.map((p) => p.displayName).sort(), ['דנה', 'רותי']);
      assert.deepEqual(found[0].kinds, ['tenant']);
    });
  });

  it('asks nothing of the database for an empty list of ids', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      assert.deepEqual(await identity.getPeople([]), []);
    });
  });

  it('lists every number that reaches one person, and [] for none', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const person = await identity.addPerson(
        { intentKey: newId(), displayName: 'דנה', kinds: ['tenant'] },
        actor,
      );

      // Someone who exists and holds no number is not an error.
      assert.deepEqual(await identity.listPhones(person.id), []);

      const first = uniquePhone();
      const second = uniquePhone();
      await identity.addPhone(
        { personId: person.id, phone: first.dashed },
        actor,
      );
      await identity.addPhone(
        { personId: person.id, phone: second.local },
        actor,
      );

      const phones = await identity.listPhones(person.id);
      // Normalised on the way in, so the list is the stored form, not the typed
      // one — the inverse of findByPhone.
      assert.deepEqual(
        phones.map((p) => p.phone).sort(),
        [first.national, second.national].sort(),
      );
      assert.ok(phones.every((p) => p.personId === person.id));
    });
  });

  it("does not hand one person another person's numbers", async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const people = [];
      for (const displayName of ['דנה', 'יוסי']) {
        people.push(
          await identity.addPerson(
            { intentKey: newId(), displayName, kinds: ['tenant'] },
            actor,
          ),
        );
      }
      const hers = uniquePhone();
      const his = uniquePhone();
      await identity.addPhone(
        { personId: people[0].id, phone: hers.local },
        actor,
      );
      await identity.addPhone(
        { personId: people[1].id, phone: his.local },
        actor,
      );

      assert.deepEqual(
        (await identity.listPhones(people[0].id)).map((p) => p.phone),
        [hers.national],
      );
      assert.deepEqual(
        (await identity.listPhones(people[1].id)).map((p) => p.phone),
        [his.national],
      );
    });
  });

  it('rejects an id that is not an id, on both new reads', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      await assert.rejects(
        () => identity.listPhones('not-a-uuid'),
        (error: KernelError) => error.code === 'invalid',
      );
      await assert.rejects(
        () => identity.getPeople([newId(), 'not-a-uuid']),
        (error: KernelError) => error.code === 'invalid',
      );
    });
  });

  it('audits both the command and its refusal', async (t) => {
    await withPool(t, async (pool) => {
      const identity = createIdentity({ pool });
      const intentKey = `test:${newId()}`;

      await identity.addPerson(
        { intentKey, displayName: 'מבוקר', kinds: ['tenant'] },
        actor,
      );
      const ok = await pool.query<{
        actor_kind: string;
        actor_id: string;
        action: string;
        outcome: string;
      }>(
        'SELECT actor_kind, actor_id, action, outcome FROM audit_log WHERE subject_id = $1',
        [intentKey],
      );
      assert.deepEqual(ok.rows, [
        {
          actor_kind: 'agent',
          actor_id: 'contract-test',
          action: 'identity.addPerson',
          outcome: 'ok',
        },
      ]);

      // A rejected command is audited too, or the trail lies by omission.
      const refusedKey = `test:${newId()}`;
      await assert.rejects(
        identity.addPerson(
          { intentKey: refusedKey, displayName: '', kinds: ['tenant'] },
          actor,
        ),
      );
      const refused = await pool.query<{ outcome: string; error_code: string }>(
        'SELECT outcome, error_code FROM audit_log WHERE subject_id = $1',
        [refusedKey],
      );
      assert.deepEqual(refused.rows, [
        { outcome: 'error', error_code: 'invalid' },
      ]);
    });
  });

  // Proves the migration's missing DEFAULT now(): the row's time is the
  // injected clock's, not the database's.
  it('writes created_at from the injected clock', async (t) => {
    await withPool(t, async (pool) => {
      const at = new Date('2026-08-23T09:00:00.000Z');
      const identity = createIdentity({ pool, clock: fixedClock(at) });
      const person = await identity.addPerson(
        { intentKey: `test:${newId()}`, displayName: 'שעון', kinds: ['staff'] },
        actor,
      );
      const row = await pool.query<{ created_at: Date }>(
        'SELECT created_at FROM identity_people WHERE id = $1',
        [person.id],
      );
      assert.equal(row.rows[0]?.created_at.toISOString(), at.toISOString());
    });
  });
});
