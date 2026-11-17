# Acceptance tests

How each of the 24 acceptance tests in the specification (section 24) is
verified. Automated tests run in CI on every push (`.github/workflows/ci.yml`):
API tests against a real PostgreSQL (`npm run test:e2e -w @jobflow/api`), web
tests (`npm test -w @jobflow/web`). Operations tests (22–24) are scripted and
must be repeated on the target Ubuntu server before go-live (section *On the
target server* below).

Test files: `apps/api/test/*.e2e-spec.ts`, `apps/web/src/test/*.test.tsx`.

| # | Requirement | Verified by | Result |
|---|---|---|---|
| 1 | Sales creates a Vehicle Branding job with a unique Job Number and a brief without customer information | `workflow.e2e-spec.ts` › *AT1/AT2* › “creates a Vehicle Branding job with a manual Job Number and no customer information”, “rejects customer fields in the Vehicle Branding brief”, “enforces the configured ERP invoice format”; `jobs.test.tsx` › “produces a Vehicle Branding brief … with no customer fields”. Duplicate Job Numbers are refused by a unique constraint (409). | Pass |
| 2 | Sales creates a Signage job and attaches drawings/specifications | `workflow.e2e-spec.ts` › “creates a Signage job and attaches drawings”; “Signage needs its drawings attached …” | Pass |
| 3 | Vehicle Branding instantiates exactly its workflow (Design, Government Approval, Vehicle Schedule, Print, Wrap, QC, Delivery) | `workflow.e2e-spec.ts` › *AT3/AT4* › “Vehicle Branding gets exactly its eight stages in order” | Pass |
| 4 | Signage has Job Brief, Design, Production, Installation, QC only; no Delivery | `workflow.e2e-spec.ts` › “Signage gets Job Brief, Design, Production, Installation and QC only”; `quality.e2e-spec.ts` › “AT18 …” (no delivery stage, delivery endpoints 404) | Pass |
| 5 | Design owned by Design Team; PRO is a separate Government Approval stage after design/customer approval | `workflow.e2e-spec.ts` › *AT5* › “Design is owned by the Design Team; PRO cannot complete it and Government Approval comes after it”; `admin.e2e-spec.ts` › “PRO has no design permissions and Design has no authority permissions” | Pass |
| 6 | Without PRO permission, authority records cannot be accessed or updated | `operations.e2e-spec.ts` › *AT6, AT8* › “only PRO (and view roles) can see authority records; others are refused even through the API” | Pass |
| 7 | Without Design permission, design work cannot be accessed or changed, even through the API | `collaboration.e2e-spec.ts` › *AT7* › “only design and sales roles can see design work; PRO cannot, even through the API” | Pass |
| 8 | Required government approval blocks downstream VB stages; Not Required is recorded with a reason by an authorised user | `operations.e2e-spec.ts` › “blocks Government Approval (and so Print and Wrap) until every required approval is granted, with evidence”; “only the PRO Leader or an administrator can mark an approval Not Required, with a reason that is audited” | Pass |
| 9 | Customer approval is manual and references the exact artwork version | `collaboration.e2e-spec.ts` › “keeps every version, ties approval to the exact version, and needs a new approval after a change” | Pass |
| 10 | A new artwork version never overwrites earlier versions | same test as 9; artwork versions are protected by a database trigger (no UPDATE/DELETE) | Pass |
| 11 | Leaders assign employees manually and set internal deadlines | `collaboration.e2e-spec.ts` › *AT11* › “leaders assign department members manually, set internal deadlines, and required tasks block the stage” | Pass |
| 12 | No access to unauthorised department channels or another job's files | `collaboration.e2e-spec.ts` › “creates one channel per stage department plus General; users only see channels they may read”, “delivers new messages live to authorised sockets only”; `workflow.e2e-spec.ts` › “files cannot be downloaded by guessing ids …” | Pass |
| 13 | Comment, reply, attach files, record/upload voice notes, mention authorised users | `collaboration.e2e-spec.ts` › “supports threads, attachments, voice notes, mentions, reactions, pins, read receipts and search”, “rejects voice notes longer than ten minutes”; voice recording checked in Chromium with a microphone (record, pause, resume, preview, upload) | Pass |
| 14 | Message edits and deletions keep audit/edit history | `collaboration.e2e-spec.ts` › “keeps edit and delete history” | Pass |
| 15 | Formal corrections are assigned, tracked, resolved and reopened with history | `collaboration.e2e-spec.ts` › *AT15* › “converts a comment into a correction that is assigned, tracked, resolved and reopened …”; `collaboration.test.tsx` | Pass |
| 16 | QC failure blocks progression and creates rework for the responsible department | `quality.e2e-spec.ts` › “AT16: a failed inspection blocks progression, creates rework for the responsible department and keeps its record”; `workflow.e2e-spec.ts` › “a QC failure returns to Print only; Wrap is not re-run” | Pass |
| 17 | Vehicle Branding cannot close until QC passes and Delivery is completed | `quality.e2e-spec.ts` › “AT17 …”; `workflow.e2e-spec.ts` › “Vehicle Branding runs through all eight stages and closes only after Delivery”; full lifecycle in the browser (below) | Pass |
| 18 | Signage closes immediately after QC approval, no Delivery | `quality.e2e-spec.ts` › “AT18: Signage closes immediately after a QC pass and has no delivery” | Pass |
| 19 | A published template change does not modify active jobs on an older version | `workflow.e2e-spec.ts` › *AT19* › “publishing a new version does not change active jobs, and published versions are immutable”; `quality.e2e-spec.ts` › “… running inspections keep their copy” | Pass |
| 20 | Retrying the same workflow event creates no duplicate stages, tasks or notifications | `workflow.e2e-spec.ts` › *AT20* › “two simultaneous completions of the same stage create only one next stage”; `outbox.e2e-spec.ts` › “does not enqueue the same logical event twice”; `collaboration.e2e-spec.ts` › “notifies the right people once per event …”; `system.e2e-spec.ts` › retrying a dead event is safe | Pass |
| 21 | Files cannot be accessed by guessing a file ID or URL | `workflow.e2e-spec.ts` › “files cannot be downloaded by guessing ids, and only permitted types are accepted” (other job's file → 404, discussion/voice files need channel access, malformed ids → 400; storage keys are random and never exposed) | Pass |
| 22 | Works on the LAN with the internet disconnected | Operations test, see below | Pass (sandbox); repeat on server |
| 23 | Database and file backups restore successfully to a test environment | `deploy/scripts/restore.sh test`, see below | Pass (sandbox); repeat on server |
| 24 | Services restart safely after a reboot; data intact | `deploy/scripts/verify.sh`, see below | Pass (sandbox); repeat on server |

## Operations tests (run 2026-11-17 on the Docker Compose stack)

**22 — Internet disconnected.** The API, worker, PostgreSQL and Redis sit on an
internal Docker network with no route out (`fetch('https://example.com')` from
the API container fails with `EAI_AGAIN`). For the test, all container traffic
to non-private addresses was also dropped at the firewall (`DOCKER-USER`: allow
10/8, 172.16/12, 192.168/16, drop everything else), and the browser was set to
abort and log any request to a host other than the server. A complete Vehicle
Branding job was then run through the browser by eight different users: job
creation, brief, artwork upload, customer approval, PRO applications with
evidence, schedule confirmation, print, wrap with photos, QC checklist with
evidence and delivery, until the job closed. Result: **0 requests outside the
LAN, no browser errors, job closed.** The web app loads no fonts, scripts or
images from the internet; HTTPS uses Caddy's internal certificate authority
(no ACME), and notifications are in-app only.

**23 — Restore to a test environment.** `backup.sh all` then `restore.sh test`:
the Restic snapshot was restored to a temporary folder, the database dump
(checksum verified) restored into a separate PostgreSQL container with no
network, and every one of the files recorded in the database checked against
its SHA-256: `snapshot latest: 70 tables, 17 users, 15 jobs, 22 files verified in 6s`.
Negative check: after damaging one uploaded file and backing up again, the
restore test failed with `0 files missing and 1 files damaged in the backup`
and the System page showed the failure. The production restore was also
exercised (`restore.sh production`): a job created after the backup was gone,
all files present, services healthy, maintenance mode off.
The weekly external copy refused to run without the disk marker and succeeded
with it (`restic copy` + `check`).

**24 — Reboot.** Row counts (jobs, users, files, messages, audit entries) and
a checksum over all uploads were recorded, the Docker daemon was stopped (all
containers stopped) and started again. All five services came back by their
restart policy, the API was healthy within about 10 seconds, the counts and
upload checksum were identical and the site answered over HTTPS. The API and
worker stop within a second on SIGTERM, so shutdowns never hit Docker's kill
timeout.

**Load check.** 50 concurrent clients requesting job lists, job details,
workflows, dashboards, reports and notifications back to back with no pause
for 30 seconds (as Management, the heaviest dashboard): 5,227 requests,
174 requests/second, **0 errors**, median 144 ms, 95th percentile 1.1 s
(queueing for database connections at saturation). Unloaded, each of these
endpoints answers in 10–60 ms. A real office of 50 users generates well under
5 requests per second, so there is ample headroom on modest hardware.

## On the target server (before go-live)

Run these on the Ubuntu 24.04 server after installation and record the output
in the go-live checklist:

1. **22:** unplug the router's internet uplink (or the server's default route
   only: `sudo ip route del default`), then from two office PCs sign in, open a
   job, upload a file, post a voice note and complete a stage. Restore the
   uplink afterwards.
2. **23:** `sudo ./deploy/scripts/backup.sh all && sudo ./deploy/scripts/restore.sh test`
   and `sudo ./deploy/scripts/backup.sh offsite` with the external disk.
3. **24:** `sudo ./deploy/scripts/verify.sh snapshot && sudo reboot`, then
   `sudo ./deploy/scripts/verify.sh compare` — every line must say `OK`.
4. From another PC: `nmap -p 22,80,443,3000,5432,6379 <server-ip>` → only
   22, 80, 443 open (see `docs/install-ubuntu.md`).
