# Changelog

## Release hardening — review fixes, speed, offline installation (unreleased)

### Added
- **Offline installation and updates.** `deploy/scripts/make-offline-bundle.sh`
  (on any PC with internet) builds one file with the images, the Ubuntu 24.04
  packages for Docker, Restic, jq, rsync and git, and the code;
  `install-offline.sh` installs the server from it and `update.sh <bundle>`
  updates it. The server never needs internet. Guide: `docs/install-offline.md`.
- Scaling: Caddy discovers API containers through Docker DNS, so
  `docker compose up -d --scale api=N` spreads the load (sticky live updates);
  `DB_POOL_MAX` sets database connections per API container.
- Regression tests for the review findings (`test/hardening.e2e-spec.ts`).

### Fixed
- Three independent code reviews; every confirmed finding fixed. The full
  list with severities is in `docs/security-review.md` (second review). Most
  important: a socket message could crash the API; live-update access was not
  re-checked after logout or access changes; failed backups could be reported
  as successful; a database-only restore could delete newer uploads; parallel
  wrong passwords did not lock accounts; other departments' tasks were
  readable by id; reports used UTC days instead of Dubai days.

### Performance
- Dashboard: a fixed handful of queries instead of about eight per department.
- Operations tab and task reminders: no per-row queries.
- New indexes for open corrections per department, the notification list and
  active task assignments.

## Phase 7 — Hardening, backups, maintenance and acceptance (unreleased)

### Added
- Backups (`deploy/scripts/backup.sh`): daily verified `pg_dump` (checked with
  `pg_restore --list`, SHA-256, kept 14 days); nightly encrypted Restic
  snapshot of uploads, database dumps, the HTTPS root certificate and
  `deploy/.env` with retention (14 daily, 8 weekly, 12 monthly) and a partial
  data check; weekly copy to an external disk (refuses to run unless the disk's
  marker file is present). systemd timers in `deploy/systemd/`, installed by
  `deploy/scripts/install-backups.sh`.
- Restore (`deploy/scripts/restore.sh`): `test` restores a snapshot into a
  throw-away PostgreSQL with no network and verifies every uploaded file
  against the SHA-256 in the database (monthly timer); `production` restores
  the live system with confirmation, a safety backup and maintenance mode;
  `--dump` restores only the database.
- Updates and rollback: `deploy/scripts/update.sh` (maintenance mode,
  pre-update backup, keeps the previous images) and `rollback.sh` (restores the
  pre-update database when the update added migrations).
- `deploy/scripts/verify.sh`: post-install/post-reboot check with
  `snapshot`/`compare` of row counts, upload checksums and the HTTPS root
  certificate.
- Maintenance mode: only administrators can work while it is on; others see
  the message and are let back in automatically. Toggle in *Administration →
  System* or with `node dist/cli/maintenance.js on|off|status`. Audited.
- *Administration → System*: database, worker heartbeat, API uptime, data-disk
  space (warning above 85%), outbox waiting/retrying/dead, the last backup,
  external copy and restore test with warnings, maintenance mode, and the
  dead-letter list with **Retry**.
- API: `GET /system/status`, `GET /system/outbox`, `POST /system/outbox/{id}/retry`,
  `GET|PUT /system/maintenance`.
- Docs: `docs/maintenance.md` (backups, restore, disaster recovery,
  maintenance mode, updates, rollback, reboots, monitoring),
  `docs/acceptance.md` (all 24 acceptance tests mapped to evidence, operations
  test results, load check, checklist for the target server),
  `docs/security-review.md`.

### Security
- `uuid` pinned to 11.1.1 (npm override) for ExcelJS: `npm audit` reports 0
  vulnerabilities.
- API Content-Security-Policy reduced to `default-src 'none'` (no Helmet
  defaults allowing `https:` sources).
- Socket.IO refuses handshakes from other origins.

### Fixed
- The worker did not exit on SIGTERM while connected to Redis and was killed
  after 30 seconds; it now stops within a second.
- `restore.sh production` checks for every required tool before stopping
  services.

### Verified
- Full Vehicle Branding lifecycle in the browser with all traffic to the
  internet dropped: 0 requests outside the LAN (acceptance test 22).
- Backup → restore test → damaged-file detection → production restore
  (acceptance test 23).
- Docker daemon restart: all services back by restart policy, data identical
  (acceptance test 24).

## Phase 6 — Dashboards and reports (unreleased)

### Added
- Role-aware dashboard (the new home page): my open and overdue tasks, my
  corrections and unread notifications; one queue per department I belong to
  (jobs at the department with days in stage, rework round, internal deadline,
  customer date and overdue flag; open, unassigned and overdue tasks; and
  department counters such as artwork awaiting approval, PRO applications
  pending or overdue, schedules awaiting confirmation, orders in progress,
  installations in the next 14 days, jobs waiting for QC). Management and
  administrators also see the company overview (active jobs, jobs completed in
  30 days, average cycle time, stages on hold, rework rounds, overdue tasks and
  open jobs by current stage) and every department queue.
- Reports page with ten reports: active jobs by stage; completed jobs and cycle
  time (by week or month); department workload; employee workload; design
  corrections and time to approval; PRO authority approvals (turnaround and
  rejection rate); production and installation progress; QC pass/fail and
  rework (with most frequent defects); vehicle schedule adherence and delivery;
  job closure after QC/delivery.
- CSV (UTF-8 with BOM, opens in Excel) and Excel (.xlsx) export, gated by
  `report.export`. Text that starts with `=`, `+`, `-` or `@` is prefixed with
  `'` so exported files cannot run spreadsheet formulas.
- API: `GET /dashboard`, `GET /reports`, `GET /reports/{key}?from&to&group&format`.

### Access
- Company-wide reports need `report.view` granted globally (Management, System
  Administrator). Department members with `report.view` see the department
  workload report for their own departments only. Employee workload is limited
  to department leaders (their departments) and global viewers. Export needs
  `report.export`, which only Management and administrators hold by default.

## Phase 5 — QC, rework, delivery and closure (unreleased)

Built
- Versioned QC checklists per service type (seeded for Vehicle Branding and
  Signage; edited in Settings — inspections keep their own copy).
- QC inspections by the Quality Team: Pass / Fail / N/A per item, comments,
  evidence photos (required where the checklist says so); submitted inspections
  can never be changed (database trigger) and every re-inspection is a new record.
- Passing completes the QC stage immediately: Signage closes, Vehicle Branding
  moves to Delivery (`quality.passed`).
- Failing records the defects, raises a blocking correction for the responsible
  department (optionally assigned), returns the job to that stage only, notifies
  the department and keeps Delivery locked until a later inspection passes.
- Delivery (Vehicle Branding only, Logistic): plan, then record the handover with
  recipient, notes and evidence; this completes the Delivery stage and closes the
  job (`logistics.delivery_completed`).
- Web: QC tab (inspection form with photos, pass, fail with rework target) and
  Delivery tab; QC checklist editor in Settings.
- All interim checklist ticks from earlier phases are now replaced by real
  records; template upgrades publish the final checks.


## Phase 4 — PRO approvals, vehicle schedule, production, installation (unreleased)

Built
- PRO / government approvals per job (RTA, Dubai Municipality, Trakhees, Civil
  Defence; administrators can add authorities): status flow Pending preparation →
  Ready → Submitted → Under review → Approved / Rejected / More information required
  → resubmission, Expired; reference numbers, dates, validity, fees, payments with
  receipts, documents (application, approval, rejection, receipt), every submission
  and decision kept; append-only status history. Approved requires an approval
  document. Not Required only by the PRO Leader or an administrator, with a reason,
  audited. Design and other departments cannot read or change authority records.
- Government Approval stage check (`authority.all_cleared`): Print and Wrap cannot
  start while any required approval is pending, rejected or expired.
- Vehicle schedules (Logistic): proposed → confirmed only with a recorded
  confirmation of vehicle availability; rescheduling a confirmed schedule needs a
  reason and re-confirmation; full history; Design, Production and Installation
  leaders are notified (`logistics.schedule_confirmed`).
- Production orders for Print (Vehicle Branding) and Production (Signage):
  activity, approved artwork version (VB prints only the latest customer-approved
  version), material, quantity, dimensions, machine/printer, operator, planned and
  actual times, wastage, progress logs with evidence; completion needs evidence
  (`production.completed`). Machines are managed in Settings.
- Installation orders for Wrap and Signage installation: vehicle/site, address,
  access and safety notes, instructions, schedule, team leader, technicians,
  materials, blocked/partial states with issues, progress logs and completion
  photos (`installation.completed`).
- Web: PRO approvals tab, Operations tab (schedule, production, installation),
  authority types and machines in Settings.
- Template upgrades publish the Phase 4 checks.


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
