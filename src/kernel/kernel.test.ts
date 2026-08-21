import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Walking-skeleton placeholder: proves the test runner, typecheck, and CI wiring.
// Replaced by real kernel contract tests in slices 2.2 and 3.1.
test('test runner and type stripping are wired', () => {
  const modules: readonly string[] = [
    'identity',
    'portfolio',
    'occupancy',
    'catalog',
    'vendor-roster',
    'case',
    'job',
    'dispatch',
    'fulfillment',
    'channel',
    'staff',
  ];
  assert.equal(modules.length, 11);
});
