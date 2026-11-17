# Changelog

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
