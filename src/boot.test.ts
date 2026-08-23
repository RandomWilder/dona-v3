import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveVersion } from './boot.ts';

describe('build identity', () => {
  it('reports the injected version when the deploy sets one', () => {
    assert.equal(
      resolveVersion({ APP_VERSION: 'v0.1.0' }, '0.1.0-dev'),
      'v0.1.0',
    );
    assert.equal(
      resolveVersion({ APP_VERSION: '4ce886f' }, '0.1.0-dev'),
      '4ce886f',
    );
  });

  // A deploy that forgot to inject must be visibly a dev build, not silently
  // wear a release number.
  it('falls back to the package version when nothing is injected', () => {
    for (const env of [{}, { APP_VERSION: '' }, { APP_VERSION: '   ' }]) {
      assert.equal(resolveVersion(env, '0.1.0-dev'), '0.1.0-dev');
    }
  });

  it('trims the injected value, so a stray newline cannot become the version', () => {
    assert.equal(
      resolveVersion({ APP_VERSION: ' v0.2.0\n' }, '0.1.0-dev'),
      'v0.2.0',
    );
  });
});
