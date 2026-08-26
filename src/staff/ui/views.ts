import type { Person } from '../../identity/contract.ts';
import { type Html, h } from '../../kernel/ui/html.ts';
import type {
  DocumentKind,
  DocumentRecord,
  OccupancyResolution,
} from '../../occupancy/contract.ts';
import type {
  AssetKind,
  Building,
  BuildingView,
} from '../../portfolio/contract.ts';
import type {
  DocumentChunks,
  PersonDetail,
  UnitDetail,
} from '../internal/queries.ts';
import type { StaffRole } from '../internal/roles.ts';
import { permits } from '../internal/roles.ts';

// The pages, as functions of what the modules returned. No template engine and
// no bundler (SPEC.md rule 6): the shell is still one HTML file, and these fill
// the hole in it.
//
// Every interpolation goes through `h`, which escapes by default. This module
// is the first thing in the system to put database text into markup.

export interface PageContext {
  role: StaffRole;
  error?: string | null;
}

const dates = new Intl.DateTimeFormat('he-IL', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Dates, ids and phone numbers read left to right inside a right-to-left page.
function ltr(value: string): Html {
  return h`<span dir="ltr">${value}</span>`;
}

function date(iso: string | null): Html {
  if (!iso) {
    return h`<span class="muted">—</span>`;
  }
  return ltr(dates.format(new Date(`${iso}T00:00:00Z`)));
}

function address(building: Building): string {
  return `${building.street} ${building.houseNumber}, ${building.city}`;
}

function crumbs(trail: Array<[string, string] | [string]>): Html {
  const parts = trail.map((step) =>
    step.length === 2
      ? h`<a href="${step[1]}">${step[0]}</a> ›`
      : h`<span>${step[0]}</span>`,
  );
  return h`<p class="crumbs">${parts}</p>`;
}

function errorNote(context: PageContext): Html {
  if (!context.error) {
    return h``;
  }
  return h`<p class="form-error" role="alert">${context.error}</p>`;
}

// A form is rendered only for a role that may submit it. This is manners, not
// security: the gate is `requireCapability` on the POST, and the test that
// proves a viewer cannot create posts the form rather than looking for it.
function createCard(context: PageContext, title: string, form: Html): Html {
  if (!permits(context.role, 'mutate')) {
    return h``;
  }
  return h`<div class="card">
          <h2>${title}</h2>
          ${errorNote(context)}
          ${form}
        </div>`;
}

function field(name: string, label: string, required = true): Html {
  return h`<p class="field">
              <label for="f-${name}">${label}</label>
              <input id="f-${name}" name="${name}" ${required ? h`required` : h``} />
            </p>`;
}

export function buildingsPage(
  buildings: Building[],
  context: PageContext,
): Html {
  const rows = buildings.map(
    (building) => h`<tr>
              <td><a href="/admin/properties/${building.id}">${building.name}</a></td>
              <td>${address(building)}</td>
            </tr>`,
  );
  const table = buildings.length
    ? h`<table class="rows">
            <caption>${buildings.length} בניינים</caption>
            <thead><tr><th>שם</th><th>כתובת</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
    : h`<p class="empty-state">אין עדיין בניינים. הוסיפו את הראשון למטה.</p>`;

  return h`<section class="panel stack">
          <h1>נכסים</h1>
          <div class="card">${table}</div>
          ${createCard(
            context,
            'בניין חדש',
            h`<form method="post" action="/admin/properties" class="stack">
              <div class="form-grid">
                ${field('name', 'שם')}
                ${field('city', 'עיר')}
                ${field('street', 'רחוב')}
                ${field('houseNumber', 'מספר בית')}
              </div>
              <button type="submit" class="submit">הוספה</button>
            </form>`,
          )}
        </section>`;
}

export function buildingPage(view: BuildingView, context: PageContext): Html {
  const rows = view.units.map(
    (unit) => h`<tr>
              <td><a href="/admin/units/${unit.id}">${unit.label}</a></td>
              <td>${unit.floor === null ? h`<span class="muted">—</span>` : ltr(String(unit.floor))}</td>
            </tr>`,
  );
  const table = view.units.length
    ? h`<table class="rows">
            <caption>${view.units.length} דירות</caption>
            <thead><tr><th>דירה</th><th>קומה</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
    : h`<p class="empty-state">אין עדיין דירות בבניין הזה.</p>`;

  return h`<section class="panel stack">
          ${crumbs([['נכסים', '/admin/properties'], [view.building.name]])}
          <h1>${view.building.name}</h1>
          <p class="muted">${address(view.building)}</p>
          <div class="card">${table}</div>
          ${createCard(
            context,
            'דירה חדשה',
            h`<form method="post" action="/admin/properties/${view.building.id}/units" class="stack">
              <div class="form-grid">
                ${field('label', 'מספר דירה')}
                ${field('floor', 'קומה', false)}
              </div>
              <button type="submit" class="submit">הוספה</button>
            </form>`,
          )}
        </section>`;
}

// The ops board is Hebrew. An asset kind is an enum the modules speak and the
// office does not, so it is named here rather than shown raw — the local
// preview rendered a boiler as `boiler`, which is how this was found.
const assetKindNames: Record<AssetKind, string> = {
  boiler: 'דוד',
  solar_heater: 'דוד שמש',
  air_conditioner: 'מזגן',
  lift: 'מעלית',
  intercom: 'אינטרקום',
  gate: 'שער',
  water_pump: 'משאבת מים',
  electrical_panel: 'לוח חשמל',
  other: 'אחר',
};

const roleNames: Record<string, string> = {
  tenant: 'דייר',
  billed: 'חיוב',
  guarantor: 'ערב',
};

// No create form on this page and so no context: a unit page is read-only in
// 10.1 for every role.
const documentKindNames: Record<DocumentKind, string> = {
  lease: 'חוזה שכירות',
  appendix: 'נספח',
  guarantee: 'ערבות',
  other: 'מסמך',
};

// Sizes read left to right inside a right-to-left page, like dates and ids.
function fileSize(bytes: number): Html {
  const mb = bytes / (1024 * 1024);
  return ltr(mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);
}

// "Not read yet" and "read, and produced nothing" are different facts, and a
// chunk count alone cannot tell them apart -- so the state comes from
// `ingestedAt` and the number beside it from the count.
function clauseCell(
  unitId: string,
  document: DocumentRecord,
  count: number | undefined,
  context: PageContext,
): Html {
  const url = `/admin/units/${unitId}/documents/${document.id}/chunks`;
  const read = document.ingestedAt !== null;
  const ingest = permits(context.role, 'mutate')
    ? h`<form method="post"
              action="/admin/units/${unitId}/documents/${document.id}/ingest"
              class="inline">
              <button type="submit" class="linkish">${read ? 'קריאה מחדש' : 'קריאת סעיפים'}</button>
            </form>`
    : h``;
  if (!read) {
    return h`<span class="muted">טרם נקרא</span> ${ingest}`;
  }
  return h`<a href="${url}">${ltr(String(count ?? 0))} סעיפים</a> ${ingest}`;
}

// The documents on a tenancy, and — for a role that may write — the form that
// adds one. A vacant flat gets neither: a document hangs off a tenancy, and
// there is none to hang it on.
function documentsCard(detail: UnitDetail, context: PageContext): Html {
  if (!detail.tenancy) {
    return h``;
  }
  const unitId = detail.unit.unit.id;
  const listed = detail.documents.length
    ? h`<table class="rows">
            <thead><tr><th>מסמך</th><th>נוסף</th><th>גודל</th><th>סעיפים</th></tr></thead>
            <tbody>${detail.documents.map(
              (document) => h`<tr>
                <td><a href="/admin/documents/${document.id}">${documentKindNames[document.kind] ?? document.kind}</a></td>
                <td>${date(document.createdAt.slice(0, 10))}</td>
                <td>${fileSize(document.byteSize)}</td>
                <td>${clauseCell(unitId, document, detail.chunkCounts[document.id], context)}</td>
              </tr>`,
            )}</tbody>
          </table>`
    : h`<p class="empty-state">אין עדיין מסמכים לתקופת השכירות הזו.</p>`;

  // The tenancy is not in this form. It is resolved from the unit on the
  // server, because a hidden field is a caller-supplied id and the caller is a
  // browser — see SPEC-staff.md, "The tenancy is resolved on the server".
  const upload = permits(context.role, 'mutate')
    ? h`<form method="post" action="/admin/units/${detail.unit.unit.id}/documents"
              enctype="multipart/form-data" class="stack">
              ${errorNote(context)}
              <div class="form-grid">
                <p class="field">
                  <label for="f-kind">סוג</label>
                  <select id="f-kind" name="kind">${Object.entries(
                    documentKindNames,
                  ).map(
                    ([value, label]) =>
                      h`<option value="${value}">${label}</option>`,
                  )}</select>
                </p>
                <p class="field">
                  <label for="f-file">קובץ PDF</label>
                  <input id="f-file" name="file" type="file" accept="application/pdf" required />
                </p>
              </div>
              <button type="submit" class="submit">העלאה</button>
            </form>`
    : h``;

  return h`<div class="card">
          <h2>מסמכים</h2>
          ${listed}
          ${upload}
        </div>`;
}

export function unitPage(detail: UnitDetail, context: PageContext): Html {
  const { unit, building } = detail.unit;
  const names = new Map(detail.people.map((person) => [person.id, person]));

  const occupants = detail.tenancy
    ? h`<table class="rows">
            <thead><tr><th>שם</th><th>תפקיד</th><th>גישה</th></tr></thead>
            <tbody>${detail.tenancy.parties.map((party) => {
              const person = names.get(party.personId);
              return h`<tr>
                <td>${
                  person
                    ? h`<a href="/admin/people/${person.id}">${person.displayName}</a>`
                    : h`<span class="muted">—</span>`
                }</td>
                <td>${party.roles.map((role) => h`<span class="tag">${roleNames[role] ?? role}</span>`)}</td>
                <td>${party.access === 'resident' ? 'מתגורר' : 'צד לחוזה'}</td>
              </tr>`;
            })}</tbody>
          </table>`
    : h`<p class="empty-state">הדירה פנויה — אין תקופת שכירות פעילה.</p>`;

  // An open-ended tenancy is a real state, not a missing value — "עד —" read
  // like a gap in the data on the local preview, so it says what it means.
  const term = detail.tenancy
    ? h`<p class="muted">
            מ־${date(detail.tenancy.tenancy.startsOn)}
            ${
              detail.tenancy.tenancy.endsOn
                ? h`עד ${date(detail.tenancy.tenancy.endsOn)}`
                : h`· ללא מועד סיום`
            }
            ${detail.tenancy.tenancy.parkingSpot ? h` · חניה ${detail.tenancy.tenancy.parkingSpot}` : h``}
            ${detail.tenancy.tenancy.storageUnit ? h` · מחסן ${detail.tenancy.tenancy.storageUnit}` : h``}
          </p>`
    : h``;

  const assets = detail.unit.assets.length
    ? h`<table class="rows">
            <thead><tr><th>ציוד</th><th>שיוך</th></tr></thead>
            <tbody>${detail.unit.assets.map(
              (asset) => h`<tr>
                <td>${asset.label ?? assetKindNames[asset.kind]}</td>
                <td>${asset.scope === 'building' ? 'בניין' : 'דירה'}</td>
              </tr>`,
            )}</tbody>
          </table>`
    : h`<p class="empty-state">אין ציוד רשום.</p>`;

  return h`<section class="panel stack">
          ${crumbs([
            ['נכסים', '/admin/properties'],
            [building.name, `/admin/properties/${building.id}`],
            [`דירה ${unit.label}`],
          ])}
          <h1>דירה ${unit.label}</h1>
          <p class="muted">${address(building)}</p>
          <div class="card">
            <h2>מי גר כאן</h2>
            ${term}
            ${occupants}
          </div>
          ${documentsCard(detail, context)}
          <div class="card">
            <h2>ציוד</h2>
            ${assets}
          </div>
        </section>`;
}

// What one document was cut into. A verification surface before it is anything
// else: the slice's bar is that a human can spot-read chunks against the PDF,
// and this is where that is done. Deliberately plain.
export function chunksPage(detail: DocumentChunks, context: PageContext): Html {
  const { unit, building } = detail.unit;
  const kind = documentKindNames[detail.document.kind] ?? detail.document.kind;

  const body = detail.chunks.length
    ? h`${detail.chunks.map(
        (chunk) => h`<div class="card">
            <p class="muted">
              ${
                chunk.clauseRef
                  ? clauseTag(chunk.clauseRef)
                  : h`<span class="muted">ללא מספור</span>`
              }
              · ${pageRange(chunk.pageFrom, chunk.pageTo)}
            </p>
            <p class="clause">${chunk.text}</p>
          </div>`,
      )}`
    : h`<p class="empty-state">המסמך טרם נקרא לסעיפים.</p>`;

  return h`<section class="panel stack">
          ${crumbs([
            ['נכסים', '/admin/properties'],
            [building.name, `/admin/properties/${building.id}`],
            [`דירה ${unit.label}`, `/admin/units/${unit.id}`],
            [kind],
          ])}
          <h1>${kind} — סעיפים</h1>
          <p class="muted">
            ${address(building)} · דירה ${unit.label} ·
            <a href="/admin/documents/${detail.document.id}">המסמך המקורי</a>
          </p>
          ${readingNote(detail.document)}
          ${searchCard(detail)}
          ${errorNote(context)}
          ${body}
        </section>`;
}

// Ask this tenancy's lease a question. The thinnest surface that can prove the
// slice: retrieval is a module command, and week 4's agent is what turns hits
// into a Hebrew sentence -- this only shows which clauses came back and how far
// each was, because that is what a human verifies a citation against.
//
// A GET with the question in the query string, so a search is a link that can be
// reloaded and shared, and so nothing here needs JavaScript.
//
// The tenancy is never in this form. It is resolved on the server from the unit
// the operator opened -- the same rule 11.2 wrote for the upload, and the reason
// editing the URL cannot reach another tenancy's lease.
function searchCard(detail: DocumentChunks): Html {
  const action = `/admin/units/${detail.unit.unit.id}/documents/${detail.document.id}/chunks`;
  const asked = detail.search;
  const results = !asked
    ? h``
    : asked.hits.length === 0
      ? h`<p class="empty-state">לא נמצאו סעיפים מתאימים בחוזה הזה.</p>`
      : h`<ol class="hits">${asked.hits.map(
          (hit) => h`<li>
                <p class="muted">
                  ${
                    hit.clauseRef
                      ? clauseTag(hit.clauseRef)
                      : h`<span class="muted">ללא מספור</span>`
                  }
                  · ${pageRange(hit.pageFrom, hit.pageTo)}
                  · <span dir="ltr">${hit.distance.toFixed(3)}</span>
                </p>
                <p class="clause">${hit.text}</p>
              </li>`,
        )}</ol>`;

  return h`<div class="card">
          <h2>חיפוש בסעיפי החוזה</h2>
          <form method="get" action="${action}" class="stack">
            <p class="field">
              <label for="f-q">שאלה</label>
              <input id="f-q" name="q" type="search"
                     value="${asked?.query ?? ''}"
                     placeholder="מה גובה דמי השכירות?" required />
            </p>
            <button type="submit" class="submit">חיפוש</button>
          </form>
          ${results}
        </div>`;
}

// What the reader could and could not see. The pages with no text layer are
// named rather than counted: OCR is week 3's cut line, and a lease four pages
// short must be able to say which four -- an operator reading an answer out of
// it is entitled to know the answer came from an incomplete document.
function readingNote(document: DocumentRecord): Html {
  if (document.ingestedAt === null) {
    return h``;
  }
  const missing = document.imageOnlyPages;
  return h`<p class="muted">
          נקרא ${date(document.ingestedAt.slice(0, 10))}
          ${document.pageCount === null ? h`` : h`· ${ltr(String(document.pageCount))} עמודים`}
          ${
            missing.length > 0
              ? h`· <strong>ללא שכבת טקסט:</strong> ${ltr(missing.join(', '))}
                  <span class="muted">(דורש הזנה ידנית)</span>`
              : h`· בכל העמודים נמצא טקסט`
          }
        </p>`;
}

// `נספח א׳ §3.1–3.3` is Hebrew followed by a number range, and inside an RTL
// paragraph the range's own dash and digits are neutral -- so it lays out
// mirrored, and the citation reads §3.3–3.1. The annex stays in the page's
// direction and the number is isolated, like every other number here.
function clauseTag(ref: string): Html {
  const cut = ref.indexOf('§');
  if (cut < 0) {
    return h`<span class="tag">${ref}</span>`;
  }
  const annex = ref.slice(0, cut).trim();
  return h`<span class="tag">${annex ? h`${annex} ` : h``}${ltr(ref.slice(cut))}</span>`;
}

// Read left to right inside a right-to-left page, like every other number here.
function pageRange(from: number, to: number): Html {
  return h`עמוד ${ltr(from === to ? String(from) : `${from}–${to}`)}`;
}

function tenancyRows(occupancy: OccupancyResolution | null): Html {
  if (!occupancy || occupancy.tenancies.length === 0) {
    return h`<p class="empty-state">אין תקופת שכירות פעילה.</p>`;
  }
  return h`<table class="rows">
          <thead><tr><th>דירה</th><th>כתובת</th><th>תפקיד</th></tr></thead>
          <tbody>${occupancy.tenancies.map(
            (tenancy) => h`<tr>
              <td><a href="/admin/units/${tenancy.unit.unit.id}">${tenancy.unit.unit.label}</a></td>
              <td>${address(tenancy.unit.building)}</td>
              <td>${tenancy.roles.map((role) => h`<span class="tag">${roleNames[role] ?? role}</span>`)}</td>
            </tr>`,
          )}</tbody>
        </table>`;
}

// A lookup, not a roster. There is deliberately no "list every person" read:
// see SPEC-staff.md — a screen whose entire content is every tenant's personal
// data, unscoped, is a liability the office does not need.
export function peoplePage(
  query: string | null,
  found: OccupancyResolution | null,
  context: PageContext,
): Html {
  let result: Html;
  if (query === null) {
    result = h`<p class="empty-state">חיפוש לפי מספר טלפון — כל צורת כתיבה תקינה.</p>`;
  } else if (!found) {
    // The same answer for a badly-formed number and one nobody holds: probing
    // this box must not teach anyone which numbers are in the system.
    result = h`<p class="empty-state">לא נמצא אדם עם המספר ${ltr(query)}.</p>`;
  } else {
    result = h`<div class="stack">
            <p><a href="/admin/people/${found.person.id}">${found.person.displayName}</a></p>
            ${tenancyRows(found)}
          </div>`;
  }

  return h`<section class="panel stack">
          <h1>אנשים</h1>
          <div class="card">
            <form method="get" action="/admin/people" class="stack">
              <div class="form-grid">
                <p class="field">
                  <label for="f-phone">טלפון</label>
                  <input id="f-phone" name="phone" dir="ltr" value="${query ?? ''}" required />
                </p>
              </div>
              <button type="submit" class="submit">חיפוש</button>
            </form>
          </div>
          <div class="card">${result}</div>
          ${createCard(
            context,
            'אדם חדש',
            h`<form method="post" action="/admin/people" class="stack">
              <div class="form-grid">
                ${field('displayName', 'שם')}
                ${field('phone', 'טלפון', false)}
              </div>
              <button type="submit" class="submit">הוספה</button>
            </form>`,
          )}
        </section>`;
}

const kindNames: Record<string, string> = {
  tenant: 'דייר',
  vendor: 'ספק',
  staff: 'צוות',
};

export function personPage(detail: PersonDetail): Html {
  const person: Person = detail.person;
  const phones = detail.phones.length
    ? h`<ul>${detail.phones.map((phone) => h`<li>${ltr(phone)}</li>`)}</ul>`
    : h`<p class="empty-state">אין מספר טלפון רשום.</p>`;

  return h`<section class="panel stack">
          ${crumbs([['אנשים', '/admin/people'], [person.displayName]])}
          <h1>${person.displayName}</h1>
          <p>${person.kinds.map((kind) => h`<span class="tag">${kindNames[kind] ?? kind}</span>`)}</p>
          <div class="card">
            <h2>טלפונים</h2>
            ${phones}
          </div>
          <div class="card">
            <h2>שכירויות</h2>
            ${tenancyRows(detail.occupancy)}
          </div>
        </section>`;
}

// The destinations week 2 does not fill. They keep their URL and their place in
// the nav so that nothing moves when their content lands.
export function emptyPage(title: string, note: string): Html {
  return h`<section class="panel stack">
          <h1>${title}</h1>
          <div class="card"><p class="empty-state">${note}</p></div>
        </section>`;
}
