-- The audit trail could say who acted but not what permitted them to. Slice 9.1
-- puts roles on staff operators, and "the role that permitted it" belongs on the
-- entry itself rather than inside `inputs`, which means the command's arguments.

-- Nullable, and no CHECK: tenant, agent and system actors hold no role, and the
-- kernel does not know any module's role vocabulary (SPEC-kernel.md).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_role text;
