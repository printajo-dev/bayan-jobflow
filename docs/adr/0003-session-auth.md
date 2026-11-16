# ADR 0003 — Server-side sessions
Status: proposed

Sessions stored in PostgreSQL (`sessions` table, hashed session ID), sent as an
HttpOnly, Secure, SameSite=Strict cookie; rotated on login and privilege change;
deleted on logout, password change and account disable. CSRF: per-session
token returned by `GET /auth/me`, required in `X-CSRF-Token` on unsafe methods.
Passwords hashed with Argon2id. Login rate limited per IP and per account.
Chosen over JWT because revocation must be immediate when an admin disables a user.
