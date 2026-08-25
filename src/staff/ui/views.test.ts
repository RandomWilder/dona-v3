import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Person } from '../../identity/contract.ts';
import type { Building } from '../../portfolio/contract.ts';
import type { UnitDetail } from '../internal/queries.ts';
import type { StaffRole } from '../internal/roles.ts';
import { buildingsPage, unitPage } from './views.ts';

// Pure rendering, no database. What these prove is the two properties the pages
// must hold no matter what the modules returned: nothing from the data can
// become markup, and a viewer is never handed a create form.

function building(overrides: Partial<Building> = {}): Building {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'בית הרצל',
    city: 'תל אביב',
    street: 'הרצל',
    houseNumber: '12',
    ...overrides,
  };
}

function context(role: StaffRole) {
  return { role, error: null };
}

describe('admin views', () => {
  it('renders a building name that looks like markup as text', () => {
    // A display name and an address are free text — typed by an operator or
    // landed by the day-8 importer — and they reach a page.
    const page = buildingsPage(
      [building({ name: '<script>alert(1)</script>' })],
      context('admin'),
    ).value;
    assert.ok(!page.includes('<script>'));
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  it('cannot be broken out of an href by an id', () => {
    const page = buildingsPage(
      [building({ id: '" onclick="steal()' })],
      context('admin'),
    ).value;
    assert.ok(!page.includes('onclick="steal()"'));
  });

  it('shows a create form to an admin and an operator', () => {
    for (const role of ['admin', 'operator'] as StaffRole[]) {
      const page = buildingsPage([], context(role)).value;
      assert.ok(
        page.includes('<form method="post" action="/admin/properties"'),
        `${role} sees the form`,
      );
    }
  });

  it('shows a viewer no create form at all', () => {
    // Manners, not security. The gate is on the POST, and the contract test
    // proves that by posting — see contract.test.ts.
    const page = buildingsPage([building()], context('viewer')).value;
    assert.ok(!page.includes('method="post" action="/admin/properties"'));
    assert.ok(!page.includes('<input'));
    // The list itself is still there: a viewer holds `read`.
    assert.ok(page.includes('בית הרצל'));
  });

  it('names an asset kind in Hebrew rather than showing the enum', () => {
    // Found on the local preview, which rendered a boiler as `boiler`.
    const detail: UnitDetail = {
      unit: {
        unit: {
          id: '22222222-2222-4222-8222-222222222222',
          buildingId: building().id,
          label: '3',
          floor: 1,
        },
        building: building(),
        assets: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            kind: 'boiler',
            label: null,
            notes: null,
            scope: 'unit',
          },
        ],
      },
      tenancy: null,
      people: [],
      documents: [],
    };
    const page = unitPage(detail, context('admin')).value;
    assert.ok(page.includes('דוד'));
    assert.ok(!page.includes('boiler'));
  });

  it('says a flat is empty rather than rendering a blank table', () => {
    const detail: UnitDetail = {
      unit: {
        unit: {
          id: '22222222-2222-4222-8222-222222222222',
          buildingId: building().id,
          label: '3',
          floor: 1,
        },
        building: building(),
        assets: [],
      },
      tenancy: null,
      people: [],
      documents: [],
    };
    const page = unitPage(detail, context('admin')).value;
    assert.ok(page.includes('הדירה פנויה'));
  });

  it('renders a party whose name is missing without dropping the others', () => {
    // getPeople omits an unknown id rather than failing, so the page must cope
    // with a party it has no name for.
    const known: Person = {
      id: '33333333-3333-4333-8333-333333333333',
      displayName: 'דנה כהן',
      language: 'he',
      kinds: ['tenant'],
    };
    const detail: UnitDetail = {
      unit: {
        unit: {
          id: '22222222-2222-4222-8222-222222222222',
          buildingId: building().id,
          label: '3',
          floor: null,
        },
        building: building(),
        assets: [],
      },
      tenancy: {
        tenancy: {
          id: '44444444-4444-4444-8444-444444444444',
          unitId: '22222222-2222-4222-8222-222222222222',
          startsOn: '2026-09-01',
          endsOn: null,
          parkingSpot: null,
          storageUnit: null,
        },
        parties: [
          { personId: known.id, roles: ['tenant'], access: 'resident' },
          {
            personId: '55555555-5555-4555-8555-555555555555',
            roles: ['guarantor'],
            access: 'party',
          },
        ],
        unit: {
          unit: {
            id: '22222222-2222-4222-8222-222222222222',
            buildingId: building().id,
            label: '3',
            floor: null,
          },
          building: building(),
          assets: [],
        },
      },
      people: [known],
      documents: [],
    };
    const page = unitPage(detail, context('admin')).value;
    assert.ok(page.includes('דנה כהן'));
    assert.ok(page.includes('ערב'));
    // An open-ended tenancy says so, rather than reading as a gap in the data.
    assert.ok(page.includes('ללא מועד סיום'));
    assert.ok(!page.includes('null'));
  });
});
