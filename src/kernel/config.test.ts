import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSettings,
  embeddingColumnDimensions,
  embeddingSettingKeys,
  extractionSettingKeys,
  readEmbeddingSettings,
  readExtractionSettings,
  type Settings,
} from './config.ts';
import type { KernelError } from './errors.ts';
import { migratedPoolOrNull, skipReason } from './pg-support.ts';

// A Settings that answers from a map, for the checks that are about the reader
// rather than about the table.
function settingsOf(values: Record<string, unknown>): Settings {
  const read = (key: string) => values[key];
  return {
    async text(key, fallback) {
      const value = read(key);
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || value.length === 0) {
        throw Object.assign(new Error('not text'), { code: 'invalid' });
      }
      return value;
    },
    async number(key, fallback) {
      const value = read(key);
      if (value === undefined) return fallback;
      if (typeof value !== 'number') {
        throw Object.assign(new Error('not a number'), { code: 'invalid' });
      }
      return value;
    },
  };
}

describe('settings', () => {
  it('reads the rows the migration seeded', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const settings = createSettings(pool);
      // Seeded in 0012 rather than defaulted in code, because a default in code
      // is the constant SPEC.md rule 4 forbids.
      assert.equal(
        await settings.text(embeddingSettingKeys.model, 'fallback'),
        'text-embedding-3-large',
      );
      assert.equal(
        await settings.number(embeddingSettingKeys.dimensions, 0),
        embeddingColumnDimensions,
      );
    } finally {
      await pool.end();
    }
  });

  it('falls back for a row that is absent, and raises for one of the wrong type', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const settings = createSettings(pool);
      // Absent is not an error: the seed lives in the migration, and a fresh
      // database mid-migration must not take the process down.
      assert.equal(await settings.text('nothing.here', 'default'), 'default');
      assert.equal(await settings.number('nothing.here', 7), 7);

      // Wrong type is different. Somebody edited a row by hand and got it
      // wrong, and reading past that would apply a setting nobody intended.
      const key = `test.wrong.${Date.now()}`;
      await pool.query(
        'INSERT INTO config_settings (key, value, updated_at) VALUES ($1, $2, now())',
        [key, JSON.stringify('not a number')],
      );
      await assert.rejects(
        settings.number(key, 1),
        (error: KernelError) => error.code === 'invalid',
      );
      await pool.query('DELETE FROM config_settings WHERE key = $1', [key]);
    } finally {
      await pool.end();
    }
  });

  it('refuses a dimension the embedding column cannot hold', async () => {
    // The trap this exists to close: a `vector(n)` column compiles its width in,
    // so this setting is schema as well as config. Changing it without a
    // migration writes vectors the column rejects. Refusing loudly is cheaper
    // than a driver error on the two-hundredth clause of a lease.
    await assert.rejects(
      readEmbeddingSettings(
        settingsOf({ [embeddingSettingKeys.dimensions]: 3072 }),
      ),
      (error: KernelError) =>
        error.code === 'invalid' &&
        error.details?.column === embeddingColumnDimensions,
    );
  });

  it('reads model and width together when they agree', async () => {
    const read = await readEmbeddingSettings(
      settingsOf({
        [embeddingSettingKeys.model]: 'text-embedding-3-large',
        [embeddingSettingKeys.dimensions]: embeddingColumnDimensions,
      }),
    );
    assert.deepEqual(read, {
      model: 'text-embedding-3-large',
      dimensions: embeddingColumnDimensions,
    });
  });

  it('reads the extraction model and effort the migrations left', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      // Read per call rather than at boot: neither is welded to anything
      // already stored, so a wrong model -- or one that reasons for minutes on
      // a browser request -- is fixed by editing a row. 0014 is what chose
      // these two values, and it chose them from a measured timeout.
      assert.deepEqual(await readExtractionSettings(createSettings(pool)), {
        model: 'gpt-5.6-luna',
        reasoningEffort: 'none',
      });
    } finally {
      await pool.end();
    }
  });

  it('takes the extraction model and effort from the rows', async () => {
    assert.deepEqual(
      await readExtractionSettings(
        settingsOf({
          [extractionSettingKeys.model]: 'some-other-model',
          [extractionSettingKeys.reasoningEffort]: 'low',
        }),
      ),
      { model: 'some-other-model', reasoningEffort: 'low' },
    );
  });

  it('turns `omit` into no effort at all, for a model that has no such knob', async () => {
    // Not the same as `none`: one asks the model for zero reasoning, the other
    // sends the provider no such field. A model without the setting refuses it.
    const read = await readExtractionSettings(
      settingsOf({ [extractionSettingKeys.reasoningEffort]: 'omit' }),
    );
    assert.equal(read.reasoningEffort, undefined);
  });

  it('refuses an effort the provider does not accept', async () => {
    // Checked here rather than discovered at the provider: an unchecked row is
    // a 400 on every extraction, and the row is the last place anyone looks.
    await assert.rejects(
      readExtractionSettings(
        settingsOf({ [extractionSettingKeys.reasoningEffort]: 'medium-ish' }),
      ),
      (error: KernelError) => error.code === 'invalid',
    );
  });
});
