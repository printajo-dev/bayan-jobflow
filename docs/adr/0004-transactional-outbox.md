# ADR 0004 — Transactional outbox
Status: proposed

Every business transaction inserts `workflow_outbox_events` rows
(`id`, `type`, `aggregate_id`, `payload`, `idempotency_key` unique, `status`,
`attempts`, `next_attempt_at`, `last_error`). The worker polls with
`FOR UPDATE SKIP LOCKED`, publishes to BullMQ, and marks rows processed.
Consumers (notifications, realtime fan-out, automation) dedupe by
`(consumer, event_id)`. Exponential backoff; after N attempts → `dead`,
visible on the admin dead-letter screen with retry. Workflow progression never
depends on a consumer: the engine changes stages synchronously in the request
transaction.
