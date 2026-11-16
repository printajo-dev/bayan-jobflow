# ADR 0001 — Modular monolith
Status: proposed

One NestJS codebase producing two processes (`api`, `worker`), one React app,
one PostgreSQL database. Modules own their tables and expose services; no
cross-module table access. Rationale: 1–10 users on one server; microservices
would add deployment and consistency cost with no benefit. Modules can be
extracted later along the same boundaries.
