# ADR 0007 — Phase 1 implementation choices
Status: accepted

**Runtime and framework versions.** Node.js 26 LTS, NestJS 12 (ESM-only),
Prisma 7 with the `pg` driver adapter, TypeScript 6. These were the current
supported releases when Phase 1 started (November 2026). TypeScript 7 (the
native compiler) is not used yet because NestJS 12's tooling targets TS 6.

**Own session auth instead of `@nestjs/authentication`.** NestJS 12 ships an
authentication module, but it is built around email verification, password
reset links and external sign-in, none of which fit an offline LAN where an
administrator resets passwords. Phase 1 implements the small subset needed
(ADR 0003) directly: Argon2id hashing, hashed session ids in PostgreSQL,
HttpOnly/SameSite=Strict `__Host-` cookie, per-session CSRF token, account
lockout, forced password change, IP rate limit on login via `@nestjs/throttler`.

**Authorization.** One global guard denies by default. Routes declare required
permissions with `@RequirePermissions()`. The `Principal` object computes
effective permissions per request from roles: GLOBAL roles apply everywhere,
DEPARTMENT roles only inside the user's departments (optionally narrowed by
`role_department_scopes`). Resource-level checks (job, stage, channel, file)
use `principal.hasInDepartment()` and arrive with those resources in Phase 2+.
Permissions are re-read on every request, so changes apply immediately.

**Validation.** Zod schemas in `packages/shared`, used by Nest's
`StandardSchemaValidationPipe` on the API and by the web forms.

**Outbox without BullMQ (for now).** The worker polls
`workflow_outbox_events` with `FOR UPDATE SKIP LOCKED`, retries with
exponential backoff and dead-letters after `OUTBOX_MAX_ATTEMPTS`. BullMQ on
Redis is added in Phase 3 when notifications need fan-out queues; Redis is
already deployed so that step needs no infrastructure change.

**Audit immutability** is enforced by a PostgreSQL trigger, not only by code.
