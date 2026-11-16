# ADR 0002 — Prisma for schema, migrations and queries
Status: proposed

Prisma schema + generated SQL migrations committed to git and reviewed.
Interactive transactions (`$transaction(async tx => …)`) carry business writes,
audit rows and outbox events together. Raw SQL (`$queryRaw` with parameters)
is allowed for reports, row locks (`FOR UPDATE` on Job Number sequences) and
DB triggers that make published template versions and history tables immutable.
Alternative considered: TypeORM (weaker migration ergonomics), Drizzle (fine,
smaller NestJS ecosystem).
