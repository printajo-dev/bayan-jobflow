# Bayan JobFlow

Internal, LAN-only job management and departmental workflow system for Bayan
(vehicle branding and signage). One integrated application: jobs, versioned
workflow templates, department stages, manual task assignment, artwork versions
and customer approval, PRO / government approval, vehicle scheduling,
production, installation, QC, delivery, department discussion channels with
voice notes, formal corrections, notifications, dashboards and audit history.

**Status:** feature-complete (Phases 0–7) — sign-in and roles, jobs with the ERP
Job Number, versioned Vehicle Branding and Signage workflows with rework, tasks,
artwork versions and customer approval, department discussions with voice
notes, corrections, notifications, PRO approvals, vehicle scheduling,
production, installation, QC, delivery, role dashboards and reports with
CSV/Excel export, backups with restore verification, maintenance mode and a
system status page. All 24 acceptance tests are mapped in
[docs/acceptance.md](docs/acceptance.md); tests 22–24 must be repeated on the
target server before go-live. See [CHANGELOG.md](CHANGELOG.md).

Using JobFlow: [docs/user-guide.md](docs/user-guide.md). API: [docs/api/](docs/api/).

Install on the office server: [docs/install-ubuntu.md](docs/install-ubuntu.md).
Administer users and roles: [docs/admin-guide.md](docs/admin-guide.md).
Backups, restore, updates, rollback: [docs/maintenance.md](docs/maintenance.md).
Develop and test: [docs/development.md](docs/development.md).

| Doc | Contents |
|---|---|
| [docs/00-architecture.md](docs/00-architecture.md) | Architecture proposal, module breakdown (backend and frontend), repository layout, Ubuntu LAN deployment plan |
| [docs/01-database-erd.md](docs/01-database-erd.md) | Initial ERD and key relationships |
| [docs/acceptance.md](docs/acceptance.md) | The 24 acceptance tests and how each is verified |
| [docs/security-review.md](docs/security-review.md) | Security controls, review findings, residual risks |
| [docs/02-workflows.md](docs/02-workflows.md) | Vehicle Branding and Signage workflows, gates, rework and closure rules |
| [docs/03-permissions.md](docs/03-permissions.md) | Permission keys and role/department matrix |
| [docs/04-delivery-plan.md](docs/04-delivery-plan.md) | Phased plan, milestones, test strategy, assumptions and open questions |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [CHANGELOG.md](CHANGELOG.md) | Changes per phase |
