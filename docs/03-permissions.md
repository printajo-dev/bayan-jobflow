# 03 — Permission model and matrix

Access is decided on the backend for every request by
`AccessPolicy.can(user, permission, resource)`:

1. **Permission** — does any of the user's roles grant the permission key?
2. **Scope** — is the role scoped to the resource's department
   (`role_department_scopes`), or is it a global role (Admin, Management)?
3. **Resource access** — is the user a job member, a member of the owning
   department, an assignee, or an explicitly added channel/stage participant?
4. Default **deny**. Every grant, revoke and scope change is audited.

Department membership says *who owns the work*; permissions say *what a user
may do*. They are stored and edited separately.

## Permission keys (seeded, admin-assignable)

| Area | Keys |
|---|---|
| Jobs | `job.view`, `job.create`, `job.edit_brief`, `job.cancel`, `job.view_customer` |
| Workflow | `stage.view`, `stage.complete`, `stage.hold`, `stage.return`, `stage.reopen`, `stage.exception` |
| Tasks | `task.view`, `task.create`, `task.assign`, `task.update_own`, `task.update_any`, `task.set_deadline` |
| Design | `artwork.view`, `artwork.upload`, `correction_round.manage`, `customer_approval.record` |
| PRO | `authority.view`, `authority.manage`, `authority.mark_not_required` |
| Logistic | `vehicle_schedule.view`, `vehicle_schedule.manage`, `delivery.manage` |
| Production | `production.view`, `production.manage` |
| Installation | `installation.view`, `installation.manage` |
| Quality | `qc.view`, `qc.inspect`, `qc.approve` |
| Discussions | `channel.view`, `message.post`, `message.voice`, `message.edit_own`, `message.delete_own`, `message.moderate`, `channel.add_participant`, `message.pin` |
| Corrections | `correction.create`, `correction.assign`, `correction.resolve`, `correction.reopen` |
| Files | `file.upload`, `file.download`, `file.delete` |
| Admin | `user.manage`, `role.manage`, `department.manage`, `template.manage`, `settings.manage`, `audit.view`, `report.view`, `report.export`, `outbox.manage` |

## Default role matrix

Legend: **F** full (all jobs) · **D** own department's stages/jobs ·
**A** assigned work only · **V** view only · **–** none.
Leaders get the employee rights plus the leader-only rows.

| Capability | Admin | Mgmt | Sales | Design | PRO | Logistic | Production | Install | Quality |
|---|---|---|---|---|---|---|---|---|---|
| View jobs / workflow timeline | F | F | F | D | D | D | D | D | D |
| Create job, edit brief | F | V | F | – | – | – | – | – | – |
| View customer details | F | F | F | – | – | – | – | – | – |
| Complete / hold / return own stage (leader) | F | configurable | D | D | D | D | D | D | D |
| Reopen stage, record exception | F | configurable | – | – | – | – | – | – | – |
| Assign employees, set internal deadline (leader) | F | – | D | D | D | D | D | D | D |
| Update own tasks | – | – | A | A | A | A | A | A | A |
| Upload artwork, correction rounds | – | V | V | D | V | – | V | V | V |
| Record customer approval | – | – | F | – | – | – | – | – | – |
| Authority applications | – | V | – | – | D | – | – | – | – |
| Mark authority Not Required | F | configurable | – | – | leader | – | – | – | – |
| Vehicle schedule, delivery | – | V | V | – | – | D | V | V | – |
| Production orders / logs | – | V | – | – | – | – | D | V | V |
| Installation orders / logs | – | V | – | – | – | V | – | D | V |
| QC inspection, pass/fail | – | V | – | – | – | – | – | – | D |
| Department channel | – | configurable | own | own | own | own | own | own | own |
| General channel | F | F | job members | job members | … | … | … | … | … |
| Create correction | F | F | D | D | D | D | D | D | D |
| Resolve assigned correction | – | – | A | A | A | A | A | A | A |
| Reports | F | F | D | D | D | D | D | D | D |
| Users, roles, templates, settings, audit, backups | F | – | – | – | – | – | – | – | – |

Notes:
- PRO has **no** Design permissions; Design has **no** authority permissions
  (acceptance tests 6–7 call the API directly to prove it).
- "configurable" means the Management role is seeded with view-only and the
  admin can grant more; every grant is audited.
- Cross-department participants are added per channel or per stage by a
  leader with `channel.add_participant`; they do not gain department-wide access.
- Admin manages the system but is not given business actions (e.g. recording
  customer approval) by default.
