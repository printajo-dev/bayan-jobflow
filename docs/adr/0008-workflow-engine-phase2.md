# ADR 0008 — Workflow engine design (Phase 2)
Status: accepted

**Templates are data.** A template has versions; a version has ordered stages
(responsible department, gate keys, checklist) and "return" rules. Publishing a
draft retires the previous version. PostgreSQL triggers make published and
retired versions (and their stages, checklists and rules) immutable, and allow
only one published version per template. Each job's workflow pins its version.

**Stage occurrences.** Every stage of the template gets occurrence 1 when the
job is created (first ACTIVE, rest PENDING), so the timeline always shows the
whole route. A return, QC failure or reopen creates occurrence n+1 of the
target stage with `returned_from_stage_id` pointing at the stage that sent the
work back. When that occurrence completes, the engine creates a new occurrence
of the origin stage — the confirmed rule "only the reopened stage runs again".
The origin occurrence inherits the origin's own `returned_from_stage_id`, so
nested rework unwinds in order.

**Concurrency and idempotency.** Each engine operation locks the job's
`job_workflows` row (`SELECT … FOR UPDATE`) and re-reads state inside the
transaction. A second simultaneous completion sees the stage already completed
and gets 409. Outbox events use the stage occurrence id in their idempotency
key, so an event can never be enqueued twice for the same transition.

**Gates.** Completion requires all required checklist items plus every gate
key's evaluator to pass. Phase 2 implements `brief.complete` and
`brief.attachments`. Gates owned by later modules are catalogued with
`available: false`; the template editor cannot select them yet. Until each
module ships, the seeded v1 templates express those requirements as required
checklist items. Each later phase publishes a new template version that adds
the data-driven gate. Administrators can *complete with exception* (reason and
unmet checks recorded).

**Job visibility.** A user sees a job if they hold `job.view` globally, or in a
department that owns any stage of the job's template version, or created it.
This makes PRO and Logistic see Vehicle Branding jobs only, without a separate
rule. Hidden jobs, their files and workflows return 404, not 403.

**Deferred tables** from the indicative ERD: `workflow_template_tasks`,
`workflow_stage_permissions` and `stage_dependencies` arrive with tasks
(Phase 3). Stage permissions are currently "department leader of the owning
department" via department-scoped roles, which matches the confirmed rules.
