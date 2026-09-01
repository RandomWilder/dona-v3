import type { Person } from '../../identity/contract.ts';
import { type Html, h } from '../../kernel/ui/html.ts';
import type {
  Confidence,
  DocumentKind,
  DocumentRecord,
  EditableGroup,
  LeaseFact,
  LeaseField,
  LeaseFieldReview,
  OccupancyResolution,
} from '../../occupancy/contract.ts';
import {
  editableGroups,
  isRetrievable,
  leaseFields,
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

  // Headed, and headed *after* the search card, because without a heading the
  // two lists are one wall of identical cards -- the owner read eight search
  // hits followed by the full document as "about 150 results", which is a
  // reasonable thing to conclude from what the page was showing.
  // Two counts and not one, since 14.1b. A chunk with no clause reference and a
  // chunk that is nothing but its own heading are stored and never embedded, so
  // a page reading "19 סעיפים" over a search that can see 16 of them is the same
  // shape of all-clear 12.1 got wrong once already -- a screen asserting more
  // than the thing behind it can support.
  const searchable = detail.chunks.filter(isRetrievable).length;
  const body = detail.chunks.length
    ? h`<h2 class="list-heading">כל הסעיפים במסמך · ${ltr(String(detail.chunks.length))}
          ${
            searchable === detail.chunks.length
              ? h``
              : h`<span class="muted">(${ltr(String(searchable))} ניתנים לחיפוש)</span>`
          }</h2>
        ${detail.chunks.map(
          (chunk) => h`<div class="card" id="clause-${chunk.id}">
            <p class="muted">
              ${
                chunk.clauseRef
                  ? clauseTag(chunk.clauseRef)
                  : h`<span class="muted">ללא מספור</span>`
              }
              · ${pageRange(chunk.pageFrom, chunk.pageTo)}
              ${
                isRetrievable(chunk)
                  ? h``
                  : h`· <span class="muted">לא נכלל בחיפוש</span>`
              }
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
          ${twinCard(detail, context)}
          ${searchCard(detail)}
          ${errorNote(context)}
          ${body}
        </section>`;
}

const leaseFieldNames: Record<LeaseField, string> = {
  term: 'תקופת השכירות',
  rent: 'דמי השכירות',
  securities: 'בטוחות',
  notice: 'הודעה מוקדמת',
  deductibles: 'חיובים והשתתפות',
};

const confidenceNames: Record<Confidence, string> = {
  high: 'ודאות גבוהה',
  medium: 'ודאות בינונית',
  low: 'ודאות נמוכה',
};

// The lease's fields, each beside the clause it was read out of, and — since
// 13.2 — beside what a human said about it. A verification surface with a
// harder job than the clause list below it: these values were produced by a
// model, so the citation is not a footnote here, it is the thing being checked,
// and it links to the clause card further down this page.
//
// One block per field rather than one table row, which is 13.2's change: a row
// that carries a value, a citation, a decision and a form is not a row.
//
// A field that was not extracted is shown as *absent*, never as empty. "The
// lease does not say" and "we did not manage to read it" are different facts,
// and a blank renders both the same way.
function twinCard(detail: DocumentChunks, context: PageContext): Html {
  const facts = new Map(detail.facts.map((fact) => [fact.field, fact]));
  const reviews = new Map(
    detail.reviews.map((review) => [review.field, review]),
  );
  const read = detail.facts[0];
  const mayWrite = permits(context.role, 'mutate');
  const extract =
    mayWrite && detail.chunks.length > 0
      ? h`<form method="post"
              action="/admin/units/${detail.unit.unit.id}/documents/${detail.document.id}/extract"
              class="inline">
              <button type="submit" class="linkish">${
                read ? 'קריאה מחדש של השדות' : 'קריאת שדות מהחוזה'
              }</button>
            </form>`
      : h``;

  const blocks = leaseFields.map((field) =>
    fieldBlock(detail, field, facts.get(field), reviews.get(field), mayWrite),
  );

  // How many of the fields that were read are settled. The count is the answer
  // to the only question this card is asked from across the room, and it is
  // deliberately over *extracted* fields: a lease that says nothing about its
  // deductibles has nothing to confirm, and counting it as outstanding would
  // make a complete review impossible to reach.
  const settled = detail.facts.filter((fact) =>
    standing(reviews.get(fact.field)),
  ).length;

  return h`<div class="card">
          <h2>שדות החוזה</h2>
          <p class="muted">
            ${
              read
                ? h`נקראו ${date(read.extractedAt.slice(0, 10))} · ${ltr(read.model)} ·
                    ${
                      settled === detail.facts.length
                        ? h`<strong>כל השדות שנקראו אושרו</strong>`
                        : h`<strong>${ltr(`${settled}/${detail.facts.length}`)}</strong> מהשדות שנקראו אושרו`
                    }`
                : h`השדות טרם נקראו מהחוזה.`
            }
            ${extract}
          </p>
          <ul class="hits">${blocks}</ul>
        </div>`;
}

// A review describes what is on the screen only while the extraction it was a
// statement about is still the extraction on the screen. `stands` is occupancy's
// answer to that, computed against the stored value rather than guessed here.
function standing(review: LeaseFieldReview | undefined): boolean {
  return review?.stands === true;
}

// One field: its state, its value, its citation, and — for a role that may
// write — the two decisions that can be made about it.
//
// The four states are four different sentences on purpose. A confirmation is a
// human's statement about *a value*, so when a re-extraction changes that value
// the confirmation does not travel with it: the field goes back to needing a
// look, and the review is still shown, named as out of date. A green tick beside
// a number nobody has ever seen is the failure the whole citation apparatus
// exists to prevent, arriving at the last step.
function fieldBlock(
  detail: DocumentChunks,
  field: LeaseField,
  fact: LeaseFact | undefined,
  review: LeaseFieldReview | undefined,
  mayWrite: boolean,
): Html {
  const name = leaseFieldNames[field];
  if (!fact) {
    return h`<li class="stack">
        <p><strong>${name}</strong> · <span class="muted">לא נקרא מהחוזה</span></p>
        ${
          review
            ? h`<p class="muted">${reviewNote(detail, review)} — <strong>אינו עדכני:</strong>
                השדה אינו נקרא מהחוזה עוד.</p>
              ${supersededValue(field, review)}`
            : h``
        }
      </li>`;
  }

  const stands = standing(review);
  const shown = stands && review ? review.value : fact.value;

  return h`<li class="stack">
      <p>
        <strong>${name}</strong> ·
        ${
          stands && review
            ? h`${review.decision === 'corrected' ? 'תוקן' : 'אושר'} ·
                <span class="muted">${reviewNote(detail, review)}</span>`
            : h`<span class="muted">טרם אושר</span>`
        }
      </p>
      ${fieldValue(field, shown)}
      <p class="muted">
        <a href="#clause-${fact.chunkId}">${
          fact.clauseRef
            ? clauseTag(fact.clauseRef)
            : h`<span class="tag">ללא מספור</span>`
        }</a>
        · ${pageRange(fact.pageFrom, fact.pageTo)}
        · ${confidenceNames[fact.confidence]}
      </p>
      ${
        stands && review?.decision === 'corrected'
          ? h`<details>
              <summary class="muted">מה שנקרא מהחוזה, לפני התיקון</summary>
              ${fieldValue(field, review.reviewedValue)}
            </details>`
          : h``
      }
      ${review && !stands ? supersededNote(detail, field, review) : h``}
      ${mayWrite ? reviewForms(detail, field, fact, stands) : h``}
    </li>`;
}

// Who decided, and when. The address rather than the id where `staff` could
// resolve one — and the id where it could not, because an operator who has
// since gone is not a reason to lose the record that they confirmed something.
function reviewNote(detail: DocumentChunks, review: LeaseFieldReview): Html {
  const who = detail.reviewers[review.reviewedById] ?? review.reviewedById;
  return h`${who} · ${date(review.reviewedAt.slice(0, 10))}`;
}

// A review the extraction has moved out from under. It says who and when, and
// -- since the value it was a statement about is the only record that the field
// used to say something else -- it says *what*, under a disclosure.
//
// That is not decoration. Keeping a superseded review instead of deleting it is
// only worth anything if the thing it preserves can be read: staging measured a
// re-read invalidating four confirmations at once, one of them a correction to a
// figure, and until this the operator's own corrected value was recoverable from
// the database and from nowhere on the screen.
function supersededNote(
  detail: DocumentChunks,
  field: LeaseField,
  review: LeaseFieldReview,
): Html {
  return h`<p class="muted"><strong>ביקורת קודמת, שאינה עדכנית:</strong>
      ${reviewNote(detail, review)}. הערך נקרא מחדש מאז והשתנה.</p>
    ${supersededValue(field, review)}`;
}

// Closed by default: what is on the screen is what the document says now, and
// this is the record of what a person said about it before. `corrected` and
// `confirmed` are named apart because they are different claims -- one is a
// value a human wrote, the other a value they agreed with.
function supersededValue(field: LeaseField, review: LeaseFieldReview): Html {
  return h`<details>
      <summary class="muted">${
        review.decision === 'corrected'
          ? 'הערך שתוקן קודם, ואינו בתוקף'
          : 'הערך שאושר קודם, ואינו בתוקף'
      }</summary>
      ${fieldValue(field, review.value)}
    </details>`;
}

// The two decisions. Confirming posts nothing about the value: the command
// copies it off the fact it reads itself. Both carry the id of the extraction
// being looked at, so a re-read between this page rendering and the press is a
// refusal rather than a name attached to a value nobody saw.
function reviewForms(
  detail: DocumentChunks,
  field: LeaseField,
  fact: LeaseFact,
  stands: boolean,
): Html {
  const base = `/admin/units/${detail.unit.unit.id}/documents/${detail.document.id}/fields/${field}`;
  const groups = editableGroups(fact.value);
  return h`<p>
      <form method="post" action="${base}/confirm" class="inline">
        <input type="hidden" name="factId" value="${fact.id}" />
        <button type="submit" class="linkish">${stands ? 'אישור מחדש' : 'אישור הערך'}</button>
      </form>
    </p>
    <details>
      <summary class="linkish">תיקון הערך</summary>
      <form method="post" action="${base}/correct" class="stack">
        <input type="hidden" name="factId" value="${fact.id}" />
        ${groups.map((group) => editGroup(group))}
        <button type="submit" class="submit">שמירת התיקון</button>
      </form>
    </details>`;
}

// One block of the correction form. The citation is printed and is not an
// input: it is what makes the value checkable against the contract, and a text
// box over it would let a person do by hand exactly what the extractor refuses
// to let the model do — name a clause that does not say this.
//
// A row of a list gets a checkbox that removes it, which is the correction the
// real lease needs first: the securities annex offers a deposit *or* a bank
// guarantee, and the twin read it as both.
function editGroup(group: EditableGroup): Html {
  const rows = group.leaves.map((leaf) => {
    const label = leafNames[lastSegment(leaf.path)] ?? lastSegment(leaf.path);
    // The long values here are the ones that quote the clause -- a re-basing
    // rule, a deductible's own words -- and a single line hides all but their
    // first few. The threshold is on the value rather than on the key, so a
    // sixth field in the registry gets the same treatment without being named.
    const long = leaf.kind === 'text' && String(leaf.value).length > 60;
    return h`<p class="field">
        <label for="e-${leaf.path}">${label}</label>
        ${
          long
            ? h`<textarea id="e-${leaf.path}" name="edit.${leaf.path}" rows="3">${String(leaf.value)}</textarea>`
            : h`<input id="e-${leaf.path}" name="edit.${leaf.path}"
                   ${leaf.kind === 'number' ? h`inputmode="numeric"` : h``}
                   value="${String(leaf.value)}" />`
        }
      </p>`;
  });
  const citation = group.clauseRef
    ? clauseTag(group.clauseRef)
    : h`<span class="muted">ללא מספור</span>`;
  if (group.row === null) {
    return h`<div class="form-grid">${rows}</div>`;
  }
  return h`<fieldset class="stack">
      <legend class="muted">${citation}</legend>
      <p class="field">
        <label>
          <input type="checkbox" name="drop.${group.row}" value="1" />
          השורה הזו אינה שייכת — הסרה
        </label>
      </p>
      <div class="form-grid">${rows}</div>
    </fieldset>`;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

// The keys of a stored value, in the office's words. Named here and not in
// `occupancy` for the reason the asset kinds are: the module speaks the
// vocabulary and the board speaks Hebrew. A key with no entry renders as itself
// rather than as nothing — a sixth field in the registry gets a usable form on
// the day it is defined, and a translation when someone writes one.
const leafNames: Record<string, string> = {
  from: 'מתאריך',
  to: 'עד תאריך',
  noticeBy: 'הודעה עד',
  capYears: 'תקרה בשנים',
  statedText: 'לשון הסעיף',
  baseAmount: 'סכום בסיס',
  currency: 'מטבע',
  indexBaseMonth: 'חודש בסיס',
  rule: 'כלל העדכון',
  kind: 'סוג',
  statedAmount: 'סכום כפי שנכתב',
  event: 'אירוע',
  days: 'ימים',
  subject: 'נושא',
};

// Rendered per field, and with no arithmetic anywhere: SPEC.md rule 7 reaches
// the presentation layer too, because a subtotal drawn on a page is a charge
// however carefully it is labelled. Every figure here is the one the contract
// prints.
function fieldValue(field: LeaseField, value: Record<string, unknown>): Html {
  if (field === 'term') {
    const term = value as {
      initial?: { from?: string | null; to?: string | null };
      options?: Array<{
        from?: string | null;
        to?: string | null;
        noticeBy?: string | null;
        clauseRef?: string | null;
      }>;
      capYears?: number | null;
      statedText?: string | null;
    };
    return h`<p>תקופה ראשונה: ${period(term.initial?.from, term.initial?.to)}</p>
        ${(term.options ?? []).map(
          (option, at) => h`<p class="muted">
            אופציה ${ltr(String(at + 1))}: ${period(option.from, option.to)}
            ${option.noticeBy ? h` · הודעה עד ${stated(option.noticeBy)}` : h``}
            ${option.clauseRef ? h` · ${clauseTag(option.clauseRef)}` : h``}
          </p>`,
        )}
        ${
          term.capYears === null || term.capYears === undefined
            ? h``
            : h`<p class="muted">תקרה: ${ltr(String(term.capYears))} שנים</p>`
        }
        ${term.statedText ? h`<p class="clause">${term.statedText}</p>` : h``}`;
  }

  if (field === 'rent') {
    const rent = value as {
      baseAmount?: string | null;
      currency?: string | null;
      indexBaseMonth?: string | null;
      rule?: string | null;
    };
    // A base figure, an index and a base month -- never "the rent today", which
    // would be a number this system computed.
    return h`<p>סכום בסיס: ${stated(rent.baseAmount)} ${rent.currency ? h`${rent.currency}` : h``}</p>
        ${rent.indexBaseMonth ? h`<p class="muted">חודש בסיס: ${stated(rent.indexBaseMonth)}</p>` : h``}
        ${rent.rule ? h`<p class="clause">${rent.rule}</p>` : h``}`;
  }

  const rows = (value as { items?: Array<Record<string, unknown>> }).items;
  if (!rows || rows.length === 0) {
    return h`<span class="muted">—</span>`;
  }
  // Each row of a list is a different clause, so each carries its own citation
  // rather than borrowing the field's.
  return h`<ul class="stack">${rows.map((row) => {
    const clause = typeof row.clauseRef === 'string' ? row.clauseRef : null;
    const head = [row.kind, row.event, row.subject].find(
      (value) => typeof value === 'string',
    ) as string | undefined;
    const amount =
      typeof row.statedAmount === 'string' ? row.statedAmount : null;
    const days = typeof row.days === 'number' ? row.days : null;
    const text = typeof row.statedText === 'string' ? row.statedText : null;
    return h`<li>
        <strong>${head ?? '—'}</strong>
        ${amount ? h` · ${stated(amount)}` : h``}
        ${days === null ? h`` : h` · ${ltr(String(days))} ימים`}
        ${clause ? h` · ${clauseTag(clause)}` : h``}
        ${text ? h`<p class="clause">${text}</p>` : h``}
      </li>`;
  })}</ul>`;
}

// A date the contract states, shown as it was read rather than reformatted: the
// annex writes some dates as words, and re-rendering one as a number would be
// this screen restating a clause instead of quoting it.
function stated(value: string | null | undefined): Html {
  return value ? ltr(value) : h`<span class="muted">—</span>`;
}

function period(
  from: string | null | undefined,
  to: string | null | undefined,
): Html {
  if (!from && !to) {
    return h`<span class="muted">—</span>`;
  }
  return h`${from ? h`מ־${stated(from)}` : h``} ${to ? h`עד ${stated(to)}` : h``}`;
}

// Ask this tenancy a question. The thinnest surface that can prove the slice:
// the ordering rule is a module command, and week 4's agent is what turns
// passages into a Hebrew sentence -- this only shows *where the answer was
// allowed to come from* and which passages, because that is what a human
// verifies a citation against.
//
// Since 14.1b this asks `channel` rather than `occupancy`. Three outcomes, and
// the screen renders all three as answers: the lease, the company's policy, or
// nothing at all. The third is not an empty result and is not styled like one --
// a refusal is what the system decided, and an operator reading "no matching
// clauses" would go looking for a bug.
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
  const answer = asked?.grounding;
  const results =
    !asked || !answer
      ? h``
      : answer.source === 'none'
        ? h`<p class="empty-state">
            <strong>אין לכך מענה בחוזה או בנהלים.</strong>
            השאלה מועברת למשרד.
          </p>`
        : h`<p class="muted">
            ${
              answer.source === 'lease'
                ? h`מתוך <strong>החוזה של הדירה הזו</strong>`
                : h`החוזה אינו עוסק בכך. מתוך <strong>נהלי המשרד</strong>`
            }
            · ${ltr(String(answer.hits.length))} קטעים
          </p>
          <ol class="hits">${answer.hits.map(
            (hit) => h`<li>
                <p class="muted">
                  ${clauseTag(hit.ref)}
                  ${
                    hit.pageFrom === undefined || hit.pageTo === undefined
                      ? h``
                      : h`· ${pageRange(hit.pageFrom, hit.pageTo)}`
                  }
                  · <span dir="ltr">${hit.distance.toFixed(3)}</span>
                </p>
                <p class="clause">${hit.text}</p>
              </li>`,
          )}</ol>`;

  return h`<div class="card">
          <h2>שאלה על הדירה</h2>
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
