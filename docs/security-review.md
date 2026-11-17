# Security review (Phase 7)

Review of the specification's security requirements (section 17) against the
code, done 2026-11-17 on the complete system. Each control lists where it is
implemented and the test that proves it.

## Controls

| Requirement | Implementation | Evidence |
|---|---|---|
| Argon2id, no plaintext passwords | `apps/api/src/auth/password.ts` (argon2id, 64 MiB, 3 iterations); passwords never returned or logged; audit entries strip password fields | `admin.e2e-spec.ts` › “never stores passwords in the audit log” |
| Secure HttpOnly SameSite cookies, CSRF | `__Host-jf_session` cookie: HttpOnly, Secure, SameSite=Strict, path `/`. Random CSRF token per session, required in `X-CSRF-Token` on every unsafe method. Same-origin check on unsafe requests and on Socket.IO handshakes | `auth.e2e-spec.ts` › CSRF and cross-origin tests |
| Session rotation, logout invalidation | Sessions stored hashed (SHA-256) server-side; new session on sign-in and after a password change (other sessions ended); logout deletes the session; idle (12 h) and absolute (7 days) expiry; disabling a user ends their sessions on the next request | `auth.e2e-spec.ts` › “invalidates the session on logout”, “forces a password change, then rotates the session and ends other sessions” |
| Login rate limiting, lockout | 10 sign-in attempts per minute per IP; account locked for 15 minutes after 5 failures; generic error message; failures audited | `auth.e2e-spec.ts` › lockout test |
| Password reset/change offline | Administrators set a temporary password; the user must change it at next sign-in (minimum 12 characters). No e-mail reset (no internet) | `app.test.tsx` › “forces a password change before anything else” |
| Input validation, parameterised queries | Every body, query and path parameter is validated by a Zod schema (`StandardSchemaValidationPipe`); unknown fields rejected. Prisma for all queries; the report queries use `$queryRaw` tagged templates (bound parameters), never string concatenation | `auth.e2e-spec.ts` › “rejects malformed bodies”; `admin.e2e-spec.ts` › malformed ids → 400 |
| RBAC, department scope, job membership, file permissions in the backend | Deny-by-default global guard; route permissions; per-resource checks in services (department-scoped permissions, job visibility by stage ownership, per-purpose file access) | `workflow.e2e-spec.ts` › job visibility; `operations.e2e-spec.ts`, `collaboration.e2e-spec.ts`, `quality.e2e-spec.ts` › refused-through-the-API tests |
| IDOR | Resources the user may not see return 404 (not 403), so ids cannot be probed; ids are UUIDv7 | `workflow.e2e-spec.ts` › “files cannot be downloaded by guessing ids” |
| Upload validation, path traversal, storage outside the web root | Type detected from content (`file-type`), extension allow-list, size limit, voice duration limit; stored under random keys in `/srv/company-data/files` (not served by Caddy); `pathFor()` refuses keys that resolve outside the root; downloads stream through the API with `nosniff`, `Content-Disposition` and a sandbox CSP | `workflow.e2e-spec.ts` › “only permitted types are accepted”; `collaboration.e2e-spec.ts` › voice limit |
| Malware scanning | Not deployed (no offline scanner on the server). Uploaded files are never executed or served inline as HTML, which limits the risk to people opening downloaded files on their PCs. Optional: install ClamAV with offline signature updates and add a scan hook in `FilesService.store` | Residual risk, see below |
| Audit of sensitive actions | Permissions/roles, users, job changes, stage completion/hold/return/reopen/exceptions, approvals, corrections, file uploads, access and deletion, settings, maintenance mode, outbox retries. Append-only: PostgreSQL triggers refuse UPDATE/DELETE on the audit log | `admin.e2e-spec.ts` › “refuses to modify or delete audit history at the database level” |
| No secrets in logs | Request log records method, path, status, duration, request id and user id only; no bodies, cookies or tokens; file contents never logged | Code review of `core/request-logger.ts` |
| Secure headers, CSP, CORS | Caddy: HSTS, strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy` (microphone/camera self only). API: CSP `default-src 'none'`. No CORS is enabled anywhere; cross-origin unsafe requests are rejected | `auth.e2e-spec.ts` › “sets security headers”; `curl -I` against the stack |
| Dependency review | `npm audit`: 0 vulnerabilities (after pinning `uuid` 11 for ExcelJS, see below). `allowScripts` in the root `package.json` only lets argon2 and Prisma run install scripts | `npm audit` output, 2026-11-17 |
| Account disable/lock by administrators | Disable/enable users; disabled users are signed out on their next request; the last active System Administrator cannot be disabled | `admin.e2e-spec.ts` › user management tests |
| Network exposure | Only Caddy publishes ports, bound to the LAN IP; PostgreSQL and Redis on an internal network with no route out; firewall guidance including the `DOCKER-USER` chain | `docs/install-ubuntu.md` § Firewall; `docs/acceptance.md` test 22 |
| Backups protected | Restic repository encrypted; password file mode 600; database dumps mode 600 in a mode-700 folder; the API only reads a status file with no secrets | `deploy/scripts/backup.sh` |

## Changes made during this review

1. **ExcelJS → `uuid` < 11.1.1 (GHSA-w5hq-g745-h8pq, moderate).** Not
   reachable (ExcelJS only calls `v4()` without a buffer), but pinned `uuid`
   11.1.1 through an npm override so the audit is clean.
2. **API Content-Security-Policy** tightened from Helmet's defaults (which allow
   `https:` fonts and styles) to `default-src 'none'; base-uri 'none';
   form-action 'none'; frame-ancestors 'none'`. The API serves only JSON and
   downloads.
3. **Socket.IO handshake origin check** added (defence in depth next to the
   SameSite=Strict cookie) against cross-site WebSocket hijacking.
4. **Clean shutdown:** the worker now closes its Redis connection on SIGTERM,
   so it stops in under a second instead of being killed after 30 seconds
   in the middle of a batch.
5. **Restore script** checks every required tool before stopping any service.

## Second review: three independent code reviews before release

Three separate reviews covered the API core (auth, access, workflow engine),
collaboration (files, discussions, realtime, notifications) and operations
(PRO, schedule, production, QC, reports, web app, deployment scripts). Every
finding was checked against the code; the confirmed ones are fixed, and the
important ones have regression tests in `apps/api/test/hardening.e2e-spec.ts`.

| Finding | Severity | Fix |
|---|---|---|
| A signed-in user could crash the API through the live-update socket (non-function acknowledgement in an async handler) | High | Input checked, handler guarded, process logs instead of exiting on stray rejections |
| Live-update sockets kept their access after logout, account disable, role change or participant removal | High | Sockets re-checked every minute and on every channel join; disable/reset and participant removal take effect immediately |
| Backups that failed could be recorded as successful (`set -e` is ignored inside `if`) | High | Steps run outside conditions; `pg_dump` status checked; wrong Restic password reported clearly |
| `restore.sh production --dump` could reuse files from an interrupted earlier restore and delete newer uploads | High | Work folder always cleared; files only restored from a snapshot restored in the same run |
| Parallel wrong passwords did not lock the account | Medium | Failure count incremented atomically in PostgreSQL |
| Login throttle per API instance | Medium | Counters shared in Redis across instances |
| Change-password had no attempt limit | Low | Throttled; wrong current passwords count towards the lockout and end all sessions at the limit |
| Tasks of another department readable by id or in the job's task list | Medium | Visible only to the department (task.view) and the assignees; others get 404 |
| Upload temp files left behind when validation failed | Medium | Removed when every response ends; hourly sweep as a safety net |
| Artwork stored before the transaction that could reject it | Medium | Validated first; stored file purged if the transaction fails |
| Reply notifications to users who lost access; deleted text in notification excerpts | Medium/Low | Access checked; deleted messages never quoted |
| Overdue reminders popped up again every 15 minutes | Medium | Live alerts only for newly created notifications; reminded tasks skipped |
| Any PRO officer could cancel an approval, bypassing the Not Required rule | Medium | Cancel and reopen limited to the PRO Leader and administrators |
| Vehicle schedule could be marked completed without confirmation, or re-timed while staying confirmed | Medium | Status transitions enforced; re-timing needs a reason and a new confirmation |
| Reports and dashboard used UTC days instead of Dubai days | Medium | Office time zone for periods, "today", grouping and displayed times |
| Failed update left the system in maintenance mode; rollback could start old code on a new database | Medium | Maintenance restored on failure; rollback checks images and the pre-update backup first; pre-update backups kept |
| Admin-only permissions honoured when granted in a department role | Low | Must be granted globally |
| Client-supplied request id used in idempotency keys | Low | Server-generated ids only |
| Last-administrator check racy; brief edits and template edits racing stage completion/publishing; trigger rejections as 500; duplicate task assignees; removed files usable as receipts; `corrections/mine` ignoring job access; N+1 queries on the Operations tab and in reminders; QC defect text attached to the wrong items in the web form | Low | All fixed |

**Accepted:** after five wrong passwords an existing account answers "locked"
(423) while an unknown username keeps answering "invalid" (401), which reveals
that the account exists. On an office LAN, telling staff clearly that their
account is locked is worth more than hiding which usernames exist.

## Residual risks and recommendations

| Risk | Rating | Recommendation |
|---|---|---|
| No malware scanning of uploads | Medium | Install ClamAV with offline definition updates if the office receives files from customers by USB/e-mail regularly. |
| PCs that skip installing the root certificate get a browser warning and could be trained to click through it | Medium | Install the certificate on every PC before go-live (`docs/install-ubuntu.md` §5); never tell users to ignore certificate warnings. |
| Single server: hardware failure stops work until restore | Medium | Keep the weekly external disk current; test the full restore procedure once a year on spare hardware; a UPS. |
| Sign-in rate limit is per IP; all PCs behind one NAT share it | Low | On a flat office LAN each PC has its own IP. Adjust `LOGIN_RATE_PER_MINUTE` if needed. |
| Administrators can read everything and change permissions | Low | Use named administrator accounts (no shared `admin`), at most two; their actions are audited and the audit log cannot be altered from the application. |
| Restic password lost → backups unreadable | High impact | Print it and store it in the safe (`docs/maintenance.md` §1). |
