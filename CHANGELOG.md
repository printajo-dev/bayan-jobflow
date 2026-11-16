# Changelog

## Phase 1 — Foundation (unreleased)

Built
- Monorepo (npm workspaces): `packages/shared`, `apps/api` (NestJS 12, Prisma 7,
  Node 26 LTS), `apps/web` (React 19, Vite 8, Mantine 9).
- Database: departments, users, roles, permissions, user↔role, user↔department
  (with leader flag), role department scopes, sessions, audit log (append-only
  via trigger), transactional outbox, system settings. First migration.
- Sign-in: Argon2id, server-side sessions (`__Host-` HttpOnly SameSite=Strict
  cookie), CSRF token, same-origin check, lockout after 5 failures (15 min),
  login rate limit, forced password change for new/reset accounts, session
  rotation and sign-out of other devices on password change.
- Access control: deny-by-default guard, `@RequirePermissions`, global and
  department-scoped roles; 59 permission keys; 16 seeded roles following the
  permission matrix (Management view-only; PRO Leader and Admin may mark
  authority Not Required; PRO has no Design permissions and vice versa).
- Admin API + screens: users (create, edit, disable/enable, roles, departments
  and leaders, reset password, unlock), departments, roles and permissions,
  audit log with before/after details.
- Outbox worker with retries, exponential backoff and dead-lettering.
- Deployment: Dockerfile (api and web targets), Docker Compose (postgres,
  redis, migrate, api, worker, caddy), Caddy HTTPS on the server IP with its
  internal CA, internal-only backend network, install/create-admin/export-ca
  scripts, Ubuntu install guide with firewall and certificate steps.
- CI workflow: typecheck, lint, unit, API e2e on PostgreSQL 17, build, images.

Not yet (planned)
- Redis is deployed but unused until BullMQ notifications (Phase 3).
- OpenAPI/Swagger docs (Phase 2). Backup/restore scripts (Phase 7; a manual
  `pg_dump` command is in the install guide meanwhile).

## Phase 0 — Discovery and design (unreleased)
- Architecture proposal, module map, ERD, workflow diagrams, permission matrix,
  phased plan, assumptions and open questions.
- ADR 0001–0006.
- Business decisions: server reached by LAN IP over HTTPS, manual Job Number = ERP invoice number, rework re-runs only the reopened stage, PRO Leader or Admin may mark authority Not Required, Management view-only.
