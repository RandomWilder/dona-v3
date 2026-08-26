import type { Pool } from 'pg';
import { KernelError } from './errors.ts';

// The kernel's settings. SPEC.md rule 4 -- policies are data, "config rows
// editable in admin, never constants" -- and until slice 12.2 nothing in this
// system had a tunable, so nothing config-shaped existed. The embedding model
// id and its width are the first, and this is the smallest thing that honours
// the rule.
//
// No admin screen. That half of rule 4 is week 5's `catalog`; until then a row
// is changed by hand, which is the honest state rather than a hidden one.

export interface Settings {
  text(key: string, fallback: string): Promise<string>;
  number(key: string, fallback: number): Promise<number>;
}

export function createSettings(pool: Pool): Settings {
  async function read(key: string): Promise<unknown> {
    const found = await pool.query<{ value: unknown }>(
      'SELECT value FROM config_settings WHERE key = $1',
      [key],
    );
    return found.rows[0]?.value;
  }

  return {
    // A fallback rather than a throw for a missing row: the seed lives in the
    // migration, and a fresh database mid-migration must not take the process
    // down. A row of the *wrong type* is different -- somebody edited it by
    // hand and got it wrong, and reading past that would apply a setting nobody
    // intended.
    async text(key, fallback) {
      const value = await read(key);
      if (value === undefined || value === null) {
        return fallback;
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new KernelError('invalid', `setting ${key} is not text`, { key });
      }
      return value;
    },

    async number(key, fallback) {
      const value = await read(key);
      if (value === undefined || value === null) {
        return fallback;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new KernelError('invalid', `setting ${key} is not a number`, {
          key,
        });
      }
      return value;
    },
  };
}

// The width the `vector(n)` column was created at, compiled in because the
// column type compiles it in. See SPEC-kernel.md, "The dimension is config and
// schema": this is the number a config row has to agree with, not a number a
// config row may freely choose.
export const embeddingColumnDimensions = 1536;

export const embeddingSettingKeys = {
  model: 'embedding.model',
  dimensions: 'embedding.dimensions',
} as const;

export interface EmbeddingSettings {
  model: string;
  dimensions: number;
}

// Read together, because they are only meaningful together, and checked against
// the schema here rather than at the insert -- where the failure would be a
// driver error on the two-hundredth row of a document, half a lease in.
export async function readEmbeddingSettings(
  settings: Settings,
): Promise<EmbeddingSettings> {
  const model = await settings.text(
    embeddingSettingKeys.model,
    'text-embedding-3-large',
  );
  const dimensions = await settings.number(
    embeddingSettingKeys.dimensions,
    embeddingColumnDimensions,
  );
  if (dimensions !== embeddingColumnDimensions) {
    // A setting that can be set to a value the system cannot honour is a trap.
    // Changing the width is a migration and a re-embed, and saying so out loud
    // is cheaper than vectors the column rejects -- or, worse, vectors nothing
    // can compare.
    throw new KernelError(
      'invalid',
      'embedding.dimensions does not match the embedding column',
      { configured: dimensions, column: embeddingColumnDimensions },
    );
  }
  return { model, dimensions };
}

export const extractionSettingKeys = {
  model: 'extraction.model',
  reasoningEffort: 'extraction.reasoning_effort',
} as const;

// What the provider accepts, plus one value of ours. Validated here rather than
// discovered at the provider: a row nobody checked becomes a 400 on every
// extraction, and the row that caused it is the last place anyone looks.
export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  // Ours, and not the provider's: send no `reasoning_effort` at all. A model
  // with no reasoning setting refuses the field rather than ignoring it, so
  // "this model has no such knob" has to be sayable in the row -- otherwise
  // falling back to such a model means a deploy, which is the thing these rows
  // exist to avoid.
  'omit',
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export interface ExtractionSettings {
  model: string;
  // `undefined` when the row says `omit`, so the caller's own "absent means do
  // not send it" rule is the only place that decision is expressed.
  reasoningEffort?: ReasoningEffort;
}

// Read per call rather than at boot, unlike the embedding model. See
// SPEC-kernel.md, "Two settings, read at two different times": these are welded
// to nothing already stored, and a model the account cannot serve -- or one
// thinking for minutes on a browser request -- must be correctable with a row
// rather than with a deploy.
//
// The defaults here match what the migration seeds, and exist for the reason
// `text()` has a fallback at all: a fresh database mid-migration must not take
// the process down.
export async function readExtractionSettings(
  settings: Settings,
): Promise<ExtractionSettings> {
  const model = await settings.text(
    extractionSettingKeys.model,
    'gpt-5.6-luna',
  );
  const effort = await settings.text(
    extractionSettingKeys.reasoningEffort,
    'none',
  );
  if (!(reasoningEfforts as readonly string[]).includes(effort)) {
    throw new KernelError(
      'invalid',
      'extraction.reasoning_effort is not a value the provider accepts',
      { configured: effort, accepted: reasoningEfforts.join(', ') },
    );
  }
  return {
    model,
    reasoningEffort:
      effort === 'omit' ? undefined : (effort as ReasoningEffort),
  };
}
