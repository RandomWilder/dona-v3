# SPEC: channel

Stub — gains its commands in its build week (see ROADMAP.md). Conventions inherited from SPEC.md.

- **Responsibility:** The agent (widget, later WhatsApp), tenant verification, tone
- **Depends on:** all modules
- **Commands:** TBD (defined here before implementation)
- **Events:** TBD
- **Success criteria:** TBD

## Presentation surface (slice 5.1)

`GET /t/:link` serves `ui/index.html` — the tenant widget shell. Registered through `contract.ts`
(`registerChannelUi`).

**Mobile first, genuinely.** This is the screen a tenant opens on a phone from a link in an SMS.
The layout is a full-height column: a chrome bar, a thread that scrolls, a composer pinned to the
bottom (`100dvh`, so the mobile URL bar cannot cover it). Above 760px it becomes a centred card —
the phone case is the default, not the fallback.

**The composer is dead on purpose.** Textarea and send button are `disabled` and say so in
Hebrew. A composer that accepts text and drops it teaches a tenant the system is broken; a
disabled one is honest. It wakes up in week 4 with the agent loop.

**`:link` is ignored, and that is deliberate.** Signed links, OTP step-up and session expiry are
week 4 (ROADMAP). Today the route serves a static shell and **never echoes the parameter into
the HTML** — no reflection, no XSS surface, nothing personal to disclose because the page holds
no data at all. When verification lands, the fail-closed rule from SPEC.md applies here first:
no personal data before server-side possession proof.

**Tone.** Hebrew, `dir="rtl"`, no English chrome. Ids, phone numbers and timestamps get
`dir="ltr"` isolation when they arrive.
