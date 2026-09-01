// The channel module's public surface. Nothing outside this module imports
// anything else from it. See SPEC-channel.md.

// Slice 14.1b. The ordering rule -- this tenancy's lease, then company policy,
// then a refusal -- lives above both modules it composes, and week 4's agent
// reaches for it as a tool rather than calling the two searches itself.
export type {
  Channel,
  ChannelDeps,
  GroundedHit,
  Grounding,
  GroundingSource,
  GroundQuestionInput,
} from './internal/grounding.ts';
export { createChannel } from './internal/grounding.ts';
// Exported because the refusal rule is the slice's central claim and the
// measurement instrument (`npm run measure`) has to be able to ask it the same
// question the command does, rather than a re-implementation of it.
export { agreement, agrees, contentTerms } from './internal/terms.ts';
export { registerChannelUi } from './ui/routes.ts';
