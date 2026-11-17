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

## Residual risks and recommendations

| Risk | Rating | Recommendation |
|---|---|---|
| No malware scanning of uploads | Medium | Install ClamAV with offline definition updates if the office receives files from customers by USB/e-mail regularly. |
| PCs that skip installing the root certificate get a browser warning and could be trained to click through it | Medium | Install the certificate on every PC before go-live (`docs/install-ubuntu.md` §5); never tell users to ignore certificate warnings. |
| Single server: hardware failure stops work until restore | Medium | Keep the weekly external disk current; test the full restore procedure once a year on spare hardware; a UPS. |
| Sign-in rate limit is per IP; all PCs behind one NAT share it | Low | On a flat office LAN each PC has its own IP. Adjust `LOGIN_RATE_PER_MINUTE` if needed. |
| Administrators can read everything and change permissions | Low | Use named administrator accounts (no shared `admin`), at most two; their actions are audited and the audit log cannot be altered from the application. |
| Restic password lost → backups unreadable | High impact | Print it and store it in the safe (`docs/maintenance.md` §1). |
