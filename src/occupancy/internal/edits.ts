// Turning a stored lease-field value into the pieces a human may change, and
// putting their changes back. Pure, like `twin.ts`, `roles.ts` and `paths.ts`:
// no clock, no pool, no model. Slice 13.2.
//
// Why this exists as its own file rather than as part of the screen: the rule
// about *what a reviewer may touch* is a fact about a lease field, not about
// HTML. A form that decided it for itself would decide it again, differently,
// the first time a second surface wanted to correct a value.
//
// The rule, and it is one line: a reviewer may change a value the extraction
// read and may drop a row that should not be there. They may never touch a
// citation. `chunkId` and `clauseRef` are what make a value checkable against
// the contract, and a text box over them would let a human do by hand exactly
// what `twin.ts` refuses to let the model do.

// A scalar a reviewer may retype, and where it lives in the value.
// `kind` comes from what is stored rather than from a schema: a count of days is
// a number in the value because the contract stated a count, and a correction
// that turned it into the string "30" would be a different shape for the same
// fact.
export interface EditableLeaf {
  path: string;
  kind: 'text' | 'number';
  value: string | number;
}

// One block of the form. `row` is null for the field's own scalars and is the
// path of an array element for a row that can be dropped -- which is the only
// difference between the two, and the reason they are one type.
export interface EditableGroup {
  row: string | null;
  leaves: EditableLeaf[];
  // Shown beside the row and never editable. Null on the group that holds the
  // field's own scalars: the field's citation is on the fact, not in the value.
  chunkId: string | null;
  clauseRef: string | null;
}

// The two keys a reviewer may not touch, named once.
const citationKeys = ['chunkId', 'clauseRef'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A leaf a reviewer may retype: a scalar the extraction actually read.
//
// A null is deliberately *not* one. Filling in a leaf the model left null is
// stating something the contract's clauses did not yield, which needs a citation
// the reviewer would have to choose -- and choosing a clause is a surface this
// slice does not build. It is also the only way to know whether a typed "30"
// should be stored as a number or as text, and guessing that from a blank box is
// how a count of days quietly becomes a string.
function leafOf(path: string, value: unknown): EditableLeaf | null {
  if (typeof value === 'string') {
    return { path, kind: 'text', value };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { path, kind: 'number', value };
  }
  return null;
}

// Walks one object's scalars, following nested objects into the same group --
// `initial.from` belongs beside `capYears`, because a reviewer reads a term as
// one thing. Arrays are not followed here: each element is its own group.
function leavesOf(
  value: Record<string, unknown>,
  prefix: string,
  into: EditableLeaf[],
): void {
  for (const [key, item] of Object.entries(value)) {
    if (citationKeys.includes(key)) {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(item)) {
      leavesOf(item, path, into);
      continue;
    }
    const leaf = leafOf(path, item);
    if (leaf) {
      into.push(leaf);
    }
  }
}

function citationOf(row: Record<string, unknown>): {
  chunkId: string | null;
  clauseRef: string | null;
} {
  return {
    chunkId: typeof row.chunkId === 'string' ? row.chunkId : null,
    clauseRef: typeof row.clauseRef === 'string' ? row.clauseRef : null,
  };
}

// The form, as a list of blocks. The field's own scalars first -- when it has
// any -- then one block per row of every list in it, in the order they are
// stored, because that is the order they are read on the page above the form.
export function editableGroups(
  value: Record<string, unknown>,
): EditableGroup[] {
  const own: EditableLeaf[] = [];
  const rows: EditableGroup[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (citationKeys.includes(key)) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const [at, element] of item.entries()) {
        if (!isRecord(element)) {
          continue;
        }
        const leaves: EditableLeaf[] = [];
        leavesOf(element, `${key}.${at}`, leaves);
        rows.push({ row: `${key}.${at}`, leaves, ...citationOf(element) });
      }
      continue;
    }
    if (isRecord(item)) {
      leavesOf(item, key, own);
      continue;
    }
    const leaf = leafOf(key, item);
    if (leaf) {
      own.push(leaf);
    }
  }
  return own.length > 0
    ? [{ row: null, leaves: own, chunkId: null, clauseRef: null }, ...rows]
    : rows;
}

// Raised where the reviewer's typing cannot be applied at all. The command
// turns it into `invalid`; this file stays free of the kernel so it can be
// tested without one.
export class EditError extends Error {}

// A path resolved against the stored value, or null where it names nothing.
// Nothing here creates structure: a path the value does not have is a path this
// form could not have rendered, which means it did not come from the form.
function locate(
  value: Record<string, unknown>,
  path: string,
): { holder: Record<string, unknown>; key: string } | null {
  const steps = path.split('.');
  const key = steps.pop();
  if (!key) {
    return null;
  }
  let holder: unknown = value;
  for (const step of steps) {
    if (Array.isArray(holder)) {
      const at = Number(step);
      holder = Number.isInteger(at) ? holder[at] : undefined;
      continue;
    }
    if (!isRecord(holder)) {
      return null;
    }
    holder = holder[step];
  }
  return isRecord(holder) && key in holder ? { holder, key } : null;
}

// Emptying a box is a correction and not a mistake: it says the contract does
// not state this after all. It stores null rather than "", which is what every
// unstated value in this schema already is.
function edited(current: unknown, typed: string): string | number | null {
  const text = typed.trim();
  if (text.length === 0) {
    return null;
  }
  if (typeof current === 'number') {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      throw new EditError(`${text} is not a number`);
    }
    return parsed;
  }
  return text;
}

// The reviewer's changes, applied to the value the *command* read -- never to a
// value a caller posted. `edits` are keyed by the paths `editableGroups`
// produced and `drops` are the rows they marked; anything naming something the
// stored value does not have is ignored rather than obeyed.
//
// Edits land before drops, so a path still means what it meant when the form was
// rendered: dropping row 0 first would silently move every later row's edits up
// one.
export function applyEdits(
  value: Record<string, unknown>,
  edits: Record<string, string>,
  drops: readonly string[],
): Record<string, unknown> {
  const next = structuredClone(value);
  for (const [path, typed] of Object.entries(edits)) {
    if (citationKeys.some((key) => path.endsWith(`.${key}`) || path === key)) {
      // A citation cannot be edited, and a post that tries is not a typo. It is
      // refused rather than dropped: silently ignoring it would let a caller
      // believe a citation had been changed.
      throw new EditError('a citation cannot be edited');
    }
    const found = locate(next, path);
    if (!found) {
      continue;
    }
    found.holder[found.key] = edited(found.holder[found.key], typed);
  }

  const dropped = new Set(drops);
  for (const [key, item] of Object.entries(next)) {
    if (!Array.isArray(item)) {
      continue;
    }
    next[key] = item.filter((_, at) => !dropped.has(`${key}.${at}`));
  }
  return next;
}
