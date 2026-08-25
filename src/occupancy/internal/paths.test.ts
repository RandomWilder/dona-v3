import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { documentPath } from './paths.ts';

describe('document paths', () => {
  const ids = () => ({
    buildingId: newId(),
    unitId: newId(),
    tenancyId: newId(),
    documentId: newId(),
  });

  it('names the place with ids and the document with its kind', () => {
    const parts = { ...ids(), kind: 'lease' as const };
    assert.equal(
      documentPath(parts),
      `leases/bldg-${parts.buildingId}/unit-${parts.unitId}/tenancy-${parts.tenancyId}/lease-${parts.documentId}.pdf`,
    );
  });

  it('is stable: the same ids give the same path', () => {
    const parts = { ...ids(), kind: 'appendix' as const };
    assert.equal(documentPath(parts), documentPath({ ...parts }));
  });

  it('carries nothing but ids and the kind', () => {
    const path = documentPath({ ...ids(), kind: 'guarantee' });
    // The rule slice 7.0 wrote: paths reach logs, so the place identifies the
    // document and the people in it never do. Anything outside this alphabet is
    // text somebody typed, and text somebody typed is where a name gets in.
    assert.match(path, /^[a-z0-9/.-]+$/);
    assert.ok(!/[֐-׿]/.test(path));
  });

  it('refuses anything that is not an id, rather than filing it', () => {
    // The failure this guard exists for: a caller reaching for the readable
    // name instead of the id, and putting a tenant's street in the bucket.
    assert.throws(
      () =>
        documentPath({
          ...ids(),
          buildingId: 'מעונות הדר',
          kind: 'lease',
        }),
      (error: KernelError) => {
        assert.equal(error.code, 'invalid');
        assert.match(error.message, /buildingId/);
        return true;
      },
    );
  });
});
