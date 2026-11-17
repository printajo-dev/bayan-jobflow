# Changelog

## Phase 3 — Tasks, design approvals, discussions, corrections, notifications (unreleased)

Built
- Tasks per stage occurrence: leaders create and assign department members
  manually; dependencies, checklists, comments, priorities; employee task
  deadline, department internal deadline (per stage) and customer date kept
  separate; required tasks block stage completion (`tasks.complete`).
- Design: immutable artwork versions (SHA-256, never overwritten, DB-protected),
  correction rounds with designer, deadline and markup files; Sales records
  customer approval manually against the exact latest version with method,
  approver, time, notes and evidence; a new version needs a new approval
  (`design.customer_approval`). PRO and other departments cannot see design work.
- Department discussion channels per job (+ General), created automatically;
  administrators can open extra channels; leaders add cross-department
  participants to one channel only. Threads, multiple attachments, browser voice
  notes (record/pause/resume/stop/preview/re-record, WebM/Opus, server-side
  type/size/duration checks, max 10 min), mentions limited to people who can
  read the channel, reactions, pins, read receipts and unread counts, full-text
  search, system messages for stage changes, approvals and corrections. Edits and
  deletes are kept in an append-only history; messages are never hard-deleted.
- Formal corrections (from a message or directly): department, stage, assignee,
  priority, deadline, blocking flag, attachments, resolution notes and evidence,
  reopen, status history (append-only); blocking corrections stop the stage
  (`corrections.closed`).
- In-app notifications produced by the worker from outbox events (idempotent per
  user and event), per-type preferences, due-soon/overdue task reminders,
  notification bell and page, “My work” page.
- Live updates with Socket.IO (session-cookie auth, room authorisation, Redis
  adapter/emitter); the app keeps working through REST if Redis or the socket is
  down.
- Seed upgrades: new template versions add the Phase 3 checks (skipped when an
  administrator already changed the template), administrator grants, and
  channels for existing jobs.


## Phase 2 — Jobs and workflow engine (unreleased)

Built
- Jobs with the manual Job Number (ERP invoice number): unique (case-insensitive,
  enforced by the database), optional admin-configured format check, correction
  with reason by Sales Leaders.
- Job briefs: Vehicle Branding (vehicles, coverage; no customer fields — the
  schema rejects them) and Signage (site, dimensions, specifications). Drafts can
  be saved incomplete; the Job Brief stage checks completeness.
- Brief attachments: content-type sniffing (not browser MIME), allow-list,
  size limit, random storage keys outside any web root, SHA-256, permission-
  checked download/preview with access log, sandboxed inline preview.
- Versioned workflow templates with draft → publish, database-enforced
  immutability of published versions, one published version per template,
  admin editor (stages, departments, checks, checklists, return rules).
- Seeded v1 templates for Vehicle Branding (8 stages) and Signage (5 stages).
- Workflow engine: gates and required checklists, complete, hold/resume, return
  for correction (only the reopened stage runs again, then back to the stage
  that returned it), administrator reopen and complete-with-exception, job
  cancellation, job closure (VB after Delivery, Signage after QC). Row locking
  prevents duplicate stages from concurrent or retried requests.
- Job visibility by department ownership of stages (PRO/Logistic see Vehicle
  Branding only); hidden jobs and files return 404.
- Web: job list with filters and pagination, new job form, job page (workflow
  timeline with actions, brief, files, activity), template editor, settings.
- OpenAPI document (`docs/api/openapi.json`), optional Swagger UI (`API_DOCS=true`).

Interim
- Stages whose evidence belongs to later modules (artwork approval, authority
  approvals, schedule, production, installation, QC, delivery) use required
  checklist items until those modules ship (ADR 0008).


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
- Backup/restore scripts (Phase 7; a manual
  `pg_dump` command is in the install guide meanwhile).

## Phase 0 — Discovery and design (unreleased)
- Architecture proposal, module map, ERD, workflow diagrams, permission matrix,
  phased plan, assumptions and open questions.
- ADR 0001–0006.
- Business decisions: server reached by LAN IP over HTTPS, manual Job Number = ERP invoice number, rework re-runs only the reopened stage, PRO Leader or Admin may mark authority Not Required, Management view-only.
