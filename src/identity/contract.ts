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
