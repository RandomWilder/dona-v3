import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSettings,
  embeddingColumnDimensions,
  embeddingSettingKeys,
  extractionSettingKeys,
  readEmbeddingSettings,
  readExtractionModel,
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

  it('reads the extraction model from its row, seeded by 0013', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      // Read per call rather than at boot: this model is welded to nothing
      // already stored, so a wrong id is fixed by editing this row.
      assert.equal(await readExtractionModel(createSettings(pool)), 'gpt-5');
    } finally {
      await pool.end();
    }
  });

  it('takes the extraction model from the row over its fallback', async () => {
    assert.equal(
      await readExtractionModel(
        settingsOf({ [extractionSettingKeys.model]: 'some-other-model' }),
      ),
      'some-other-model',
    );
  });
});
