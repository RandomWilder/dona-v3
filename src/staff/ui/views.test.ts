import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Person } from '../../identity/contract.ts';
import type { LeaseFact } from '../../occupancy/contract.ts';
import type { Building } from '../../portfolio/contract.ts';
import type { DocumentChunks, UnitDetail } from '../internal/queries.ts';
import type { StaffRole } from '../internal/roles.ts';
import { buildingsPage, chunksPage, unitPage } from './views.ts';

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
      chunkCounts: {},
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
      chunkCounts: {},
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
      chunkCounts: {},
    };
    const page = unitPage(detail, context('admin')).value;
    assert.ok(page.includes('דנה כהן'));
    assert.ok(page.includes('ערב'));
    // An open-ended tenancy says so, rather than reading as a gap in the data.
    assert.ok(page.includes('ללא מועד סיום'));
    assert.ok(!page.includes('null'));
  });
  it('keeps a clause number from reading backwards in a Hebrew page', () => {
    // `נספח א׳ §3.1–3.3` is Hebrew followed by a range whose dash and digits
    // are bidi-neutral: laid out in the page's direction it renders as
    // §3.3–3.1, which is a citation pointing somewhere else.
    const page = chunksPage(
      chunkDetail('נספח א׳ §3.1–3.3'),
      context('admin'),
    ).value;
    assert.ok(page.includes('<span dir="ltr">§3.1–3.3</span>'));
    assert.ok(page.includes('נספח א׳'));
  });

  it('says a document has not been read rather than showing an empty page', () => {
    const detail = chunkDetail('§1');
    const page = chunksPage({ ...detail, chunks: [] }, context('admin')).value;
    assert.ok(page.includes('טרם נקרא'));
  });

  it('marks a chunk with no clause number instead of inventing one', () => {
    const detail = chunkDetail('§1');
    const chunk = detail.chunks[0];
    const page = chunksPage(
      { ...detail, chunks: [{ ...chunk, clauseRef: null }] },
      context('admin'),
    ).value;
    assert.ok(page.includes('ללא מספור'));
  });
  it('names the pages that carried no text layer, rather than counting them', () => {
    // OCR is week 3's cut line. A lease four pages short must say which four:
    // an operator reading an answer out of it is entitled to know the answer
    // came from an incomplete document.
    const detail = chunkDetail('§1');
    const page = chunksPage(
      {
        ...detail,
        document: { ...detail.document, imageOnlyPages: [2, 17, 33, 38] },
      },
      context('admin'),
    ).value;
    assert.ok(page.includes('ללא שכבת טקסט'));
    assert.ok(page.includes('2, 17, 33, 38'));
    assert.ok(page.includes('הזנה ידנית'));
  });

  it('says so plainly when every page carried text', () => {
    const page = chunksPage(chunkDetail('§1'), context('admin')).value;
    assert.ok(page.includes('בכל העמודים נמצא טקסט'));
    assert.ok(page.includes('38'));
  });

  it('shows an extracted field beside a link to the clause it cites', () => {
    const detail = chunkDetail('נספח א׳ §5');
    const page = chunksPage(
      { ...detail, facts: [fact()] },
      context('admin'),
    ).value;

    assert.ok(page.includes('תקופת השכירות'));
    // The citation is the thing being checked, so it links to the clause card
    // further down this page rather than sitting as a footnote.
    assert.ok(page.includes('href="#clause-c1"'));
    assert.ok(page.includes('id="clause-c1"'));
    // An initial period and its options -- there is no single end date to show.
    assert.ok(page.includes('תקופה ראשונה'));
    assert.ok(page.includes('אופציה'));
    assert.ok(page.includes('טרם אושרו'));
  });

  it('shows a field that was not extracted as absent, not as empty', () => {
    // "The lease does not say" and "we did not manage to read it" are different
    // facts, and a blank renders both the same way.
    const page = chunksPage(
      { ...chunkDetail('§1'), facts: [fact()] },
      context('admin'),
    ).value;
    assert.ok(page.includes('לא נקרא מהחוזה'));
  });

  it('offers the extract button to a role that may write, and to no other', () => {
    const detail = chunkDetail('§1');
    const admin = chunksPage(detail, context('admin')).value;
    const viewer = chunksPage(detail, context('viewer')).value;

    assert.ok(admin.includes('/documents/d1/extract'));
    // The same guard that refuses a viewer an ingest: reading a lease into
    // fields writes rows.
    assert.equal(viewer.includes('/documents/d1/extract'), false);
  });

  it('shows no figure the contract did not print', () => {
    const page = chunksPage(
      {
        ...chunkDetail('נספח א׳ §10'),
        facts: [
          fact({
            field: 'rent',
            value: {
              baseAmount: '4,250',
              currency: 'ש"ח',
              indexBaseMonth: 'ינואר 2026',
              rule: 'עדכון שנתי לפי המדד',
            },
          }),
        ],
      },
      context('admin'),
    ).value;

    // The base figure as printed, the index and the base month -- and nothing
    // that looks like "the rent today", which would be a charge computed on a
    // page (SPEC.md rule 7).
    assert.ok(page.includes('4,250'));
    assert.ok(page.includes('חודש בסיס'));
    assert.equal(page.includes('סה"כ'), false);
  });
});

// One document's chunks, for the chunks page.
function chunkDetail(clauseRef: string): DocumentChunks {
  return {
    unit: {
      unit: { id: 'u1', buildingId: 'b1', label: '5', floor: 2 },
      building: building({}),
      assets: [],
    },
    document: {
      id: 'd1',
      tenancyId: 't1',
      kind: 'lease',
      objectPath: 'leases/…',
      contentType: 'application/pdf',
      byteSize: 1024,
      createdAt: '2026-08-25T09:00:00.000Z',
      ingestedAt: '2026-08-25T10:00:00.000Z',
      pageCount: 38,
      imageOnlyPages: [],
    },
    chunks: [
      {
        id: 'c1',
        documentId: 'd1',
        tenancyId: 't1',
        ordinal: 0,
        clauseRef,
        heading: null,
        pageFrom: 14,
        pageTo: 15,
        text: 'השוכר ישלם את דמי השכירות מראש.',
        createdAt: '2026-08-25T09:00:00.000Z',
      },
    ],
    search: null,
    facts: [],
  };
}

// One extracted field, for the twin card.
function fact(over: Partial<LeaseFact> = {}): LeaseFact {
  return {
    id: 'f1',
    documentId: 'd1',
    tenancyId: 't1',
    field: 'term',
    value: {
      initial: { from: '2026-01-01', to: '2027-12-31' },
      options: [{ from: '2028-01-01', to: '2029-12-31', noticeBy: null }],
      capYears: 10,
      statedText: null,
    },
    chunkId: 'c1',
    clauseRef: 'נספח א׳ §5',
    pageFrom: 15,
    pageTo: 15,
    confidence: 'high',
    model: 'gpt-5',
    extractedAt: '2026-08-26T10:00:00.000Z',
    ...over,
  };
}
