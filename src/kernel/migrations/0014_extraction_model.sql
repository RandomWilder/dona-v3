-- The extraction model, chosen by measurement rather than by argument.
--
-- `0013` seeded `gpt-5` on reasoning about the config mechanism and never about
-- latency, and the first press on staging measured what that cost: five
-- sequential calls, each at the provider's *default* reasoning effort, did not
-- finish inside Cloud Run's 300-second request timeout. The operator got a
-- blank page and the twin was never written -- correct, and useless.
--
-- Two things change here, and only one of them is the model.

-- The tier. `gpt-5.6-luna` is the family's cost-and-latency tier -- documented
-- for high-volume, latency-sensitive work -- at a fraction of the flagship's
-- price, with the same context window and the same strict json_schema support
-- the extractor already relies on. Reading a table of commercial terms out of
-- clauses that were *selected deterministically* is not frontier work: the hard
-- part, finding the right clauses, happened before the model was called.
UPDATE config_settings
   SET value = '"gpt-5.6-luna"', updated_at = now()
 WHERE key = 'extraction.model';

-- The knob that actually caused the timeout. Unset is not the same as none:
-- unset means the provider's default effort, and this model family reasons by
-- default. `none` is the documented latency baseline, and it is the right
-- starting point for extraction against pre-selected clauses -- with `low` the
-- next rung if a field comes back wrong rather than slow.
--
-- A row rather than a constant precisely so that rung costs no deploy
-- (SPEC.md rule 4). `omit` is the value that sends no parameter at all, for a
-- model that has no such setting.
INSERT INTO config_settings (key, value, updated_at) VALUES
  ('extraction.reasoning_effort', '"none"', now())
ON CONFLICT (key) DO NOTHING;
