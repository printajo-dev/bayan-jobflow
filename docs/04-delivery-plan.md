# 04 — Phased plan, test strategy, assumptions, open questions

## Phases

| Phase | Builds | Exit criteria | Acceptance tests covered |
|---|---|---|---|
| 0 Design | These docs | Docs reviewed and open questions answered | – |
| 1 Foundation | Monorepo, Docker Compose (api, worker, web, postgres, redis, caddy), Prisma + first migrations, config, logging, health, auth (Argon2id, sessions, CSRF, rate limit, lock), users/departments/roles/permissions + `AccessPolicy`, audit log, outbox skeleton, admin screens for users/roles/departments, seed-admin script | Secure login; admin manages users/roles/departments; `docker compose up` on a clean Ubuntu VM works | 24 (restart) partial |
| 2 Jobs + engine | Service types, manual Job Number (unique), briefs (VB without customer, SG with drawings), template versions + editor + publish, engine (instantiate, gates, complete, hold, return, reopen, occurrences), seeded VB and SG templates, activity history | Both templates run end to end with the right stage order | 1, 2, 3, 4, 5, 19, 20 |
| 3 Tasks, design, discussions | Tasks and manual assignment, separate deadlines, file module, artwork versions, correction rounds, customer approval, channels, threads, attachments, voice notes, mentions, reactions, pins, read receipts, edits, search, corrections, Socket.IO, notifications | Design and channel communication work with permissions and history | 7, 9, 10, 11, 12, 13, 14, 15, 21 |
| 4 PRO and operations | Authority types/applications/submissions/payments, Not-Required exception, vehicle schedules, production, installation | VB cannot pass the authority/schedule gates without them | 6, 8 |
| 5 QC and closure | QC checklist templates, inspections, fail → rework, re-inspection, delivery, closure | VB closes after delivery; SG closes after QC pass; QC fail creates rework | 16, 17, 18 |
| 6 Dashboards and reports | Role dashboards, job search/filters, metrics, CSV/XLSX export | Each role sees the right queues | – |
| 7 Hardening and deploy | Security review, CSP/headers, dependency audit, load check, backup/restore scripts + timers, offline test, install/LAN/HTTPS/admin/user/maintenance guides | Acceptance suite passes on the target Ubuntu LAN server | 22, 23, 24 |

Each phase ends with: migrations applied from scratch, lint, type check, unit
and integration tests green, CHANGELOG entry, and a report (built, files,
tests, known issues, next phase).

## Test strategy

- **Unit (Vitest/Jest):** gate evaluators, `AccessPolicy`, Job Number
  generation, rework occurrence logic, file type sniffing.
- **API integration (Jest + Supertest + Testcontainers Postgres/Redis):** every
  endpoint tested with an allowed and a denied user; IDOR tests (other job's
  file/channel/message IDs → 404); idempotency tests that replay outbox events.
- **Acceptance (Playwright against Docker Compose):** the 24 acceptance tests
  from the spec as named scenarios, seeded with fictional users and jobs.
- **Ops tests (scripted):** restore last night's backup into a scratch stack
  and compare row counts and file checksums; reboot test; unplug-WAN test.

## Assumptions (safe defaults, will be used unless you say otherwise)

1. UI language English, left-to-right; built i18n-ready so Arabic/RTL can be added.
2. Time zone `Asia/Dubai`, currency AED for authority fees.
3. Job Number is entered manually (ERP invoice number); no automatic numbering.
4. Customer approval can be recorded in Signage Design as well; it is a required gate in VB and a configurable one in SG (on by default).
5. Authority types seeded: RTA, Dubai Municipality, Trakhees, Civil Defence (admin-editable). The PRO leader decides per job which are required.
6. Vehicle Branding brief fields: vehicle count, make/model/year, plate or chassis reference, colour, coverage (full/partial/decals), scope, requirements, target date, attachments.
7. Upload limit 500 MB per file by default, chunked upload above 50 MB; voice notes max 10 minutes, WebM/Opus.
8. No email/SMS; notifications are in-app only (no internet dependency).
9. Password policy: min 12 characters; lock after 5 failed attempts for 15 minutes; admin resets passwords (no email reset offline).
10. Node.js and PostgreSQL versions: latest LTS / supported major at the start of Phase 1, pinned in `.nvmrc`, Dockerfiles and `package-lock.json`.
11. One server, one company, one branch for now; `branch_id` is not added until needed.

## Decisions confirmed by the business (2026-11-16)

| # | Topic | Decision |
|---|---|---|
| Q1 | Access and HTTPS | Users connect by the server's LAN IP (`https://<server IP>`); no DNS. Caddy internal certificate for the IP, root cert installed on each office PC. Server needs a static IP / DHCP reservation. |
| Q2 | Job Number | Entered manually by Sales, matching the ERP invoice number. Unique; no auto-generation. |
| Q3 | Rework scope | Only the reopened stage runs again, then back to the stage that returned it. |
| Q4 | Authority Not Required | System Administrator and PRO Leader, with reason and audit. |
| Q5 | Management | View only. |

## Still open (non-blocking)

- Exact ERP invoice number format, if a format check is wanted (otherwise any
  non-empty unique value is accepted).
- The server's fixed LAN IP, needed at install time.
