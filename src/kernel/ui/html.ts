// Escaping values into HTML. Every screen before slice 10.1 was a static file
// and nothing from a request or a database ever reached the markup — the login
// route says so as a property of itself. The admin views end that: a tenant's
// name, a building's street and an operator's own typing all now land inside a
// page.
//
// This is in the kernel and not in `staff` for the reason slice 7.1 moved
// `requireText` here: `channel` renders tenant-supplied text in week 4, and a
// second copy of an escaper is a copy that drifts.

// Ampersand first, so an entity this function writes is never re-escaped by a
// later replacement in the same pass.
const entities: Array<[RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&#39;'],
];

export function escapeHtml(value: string): string {
  let out = value;
  for (const [pattern, entity] of entities) {
    out = out.replace(pattern, entity);
  }
  return out;
}

// `null` and `undefined` render as nothing rather than as the words "null" and
// "undefined" — which is what a nullable floor or end date wants. Numbers are
// numbers. Anything else is a bug at the call site and says so: `String({})` is
// `[object Object]`, which hides the mistake instead of surfacing it.
function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new TypeError(`cannot render ${typeof value} into HTML`);
}

// The form the views use. Literal parts of the template pass through untouched;
// every `${}` is escaped. The direction is the whole point: escaping by default
// makes forgetting impossible, where an `escapeHtml()` you must remember to
// write is one edit away from an injection.
//
// There is deliberately no "raw" or "trusted" escape hatch. A view that composes
// markup nests one `h` inside another — nested results arrive as Html and are
// spliced in rather than escaped twice.
// An explicit field rather than a constructor parameter property: parameter
// properties are not erasable syntax, and Node 24 strips types rather than
// compiling them (AGENTS.md).
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

function render(value: unknown): string {
  if (value instanceof Html) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  return escapeHtml(stringify(value));
}

export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + strings[i + 1];
  }
  return new Html(out);
}
