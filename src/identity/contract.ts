// The identity module's public surface. Nothing outside this module reaches past
// this file — internals live under `internal/`. See SPEC-identity.md.
export type {
  Actor,
  AddPersonInput,
  AddPhoneInput,
  Identity,
  IdentityDeps,
  Language,
  Person,
  PersonKind,
  PhoneLink,
} from './internal/people.ts';
export { createIdentity, languages, personKinds } from './internal/people.ts';
// Promoted in slice 8.1: the day-8 importer needs one phone to key one person,
// and re-deriving the rule outside this module would be a second, drifting copy.
export { normalizePhone } from './internal/phone.ts';
