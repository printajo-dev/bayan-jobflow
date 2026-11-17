# Administrator guide

Everything here is under **Administration** in the left menu, visible only to
users whose roles grant the matching permission. The server checks every
permission again on every request; hiding a menu item is only a convenience.

## Concepts

- **Department membership** says whose work a user does (Sales, Design, PRO…),
  and whether they are the department's **leader**.
- **Roles** say what a user may do. A role is either:
  - **Global** — applies to every department (System Administrator, Management);
  - **Department** — applies only inside the departments the user belongs to.
    A department role can also be limited to specific departments (for example
    *PRO Leader* only counts inside *PRO Section*).
- A user can have several departments and several roles.

## Seeded roles

| Role | Scope | Summary |
|---|---|---|
| System Administrator | Global | Users, roles, departments, settings, audit; can mark an authority approval Not Required; can reopen stages and record exceptions. |
| Management | Global | **View only**: all jobs, stages, channels, reports and exports. |
| *Department* Employee | Department | Assigned tasks, department channels, files, corrections. |
| *Department* Leader | Department | Employee rights plus assigning work, deadlines, completing/holding/returning the department's stages. |

Department-specific extras: Sales records customer approval and creates jobs;
Design uploads artwork; PRO manages authority applications (PRO Leader can mark
Not Required); Logistic manages vehicle schedules and delivery; Production,
Installation and Quality manage their own records. PRO has no Design
permissions and Design has no PRO permissions. The full matrix is in
`docs/03-permissions.md`.

Seeded roles can be edited. Updates to the application never overwrite your
changes to existing roles or departments.

## Adding a user

1. *Users → New user*: full name, username, a temporary password (12+
   characters), departments and roles.
2. Open the user and tick **Leader** next to a department if they lead it.
3. Give them the temporary password in person. At first sign-in they must
   choose their own password before they can do anything else.

## Everyday tasks

| Task | Where |
|---|---|
| Forgotten password | User page → *Reset password*. All their sessions end; they choose a new password at next sign-in. |
| Locked after 5 wrong passwords | It unlocks itself after 15 minutes, or user page → *Unlock*. |
| Someone leaves | User page → *Disable*. They are signed out immediately. Users are never deleted, so their history stays. |
| Change what a role may do | *Roles & permissions* → role → tick permissions → *Save permissions*. Takes effect on each user's next action. |
| Rename a department | *Departments* → *Edit*. The code (e.g. `SALES`) is permanent. |

Safety rules enforced by the server: you cannot disable yourself, the last
active System Administrator cannot be disabled or lose that role, and the
System Administrator role always keeps user and role management.

## Audit log

Every sign-in, failed sign-in, lockout, password change/reset and every change
to users, roles, permissions and departments is recorded with who, when, from
which IP, and before/after values. Passwords are never recorded. The database
refuses any change or deletion of audit records.

## Workflow templates

*Administration → Workflow templates* lists the Vehicle Branding and Signage
templates and their versions.

- **Published** versions are used by new jobs. They cannot be edited.
- **Retired** versions are still used by the jobs that started on them.
- To change a workflow, press *New draft version*. The draft starts as a copy of
  the published version. Edit stages (name, responsible department, description,
  automatic checks, checklist items), reorder them, add or remove stages, and
  define which stage may return work to which earlier stage. *Save draft* as
  often as you like; *Publish* when ready.
- Publishing never changes running jobs. Only one draft per template exists at
  a time; *Delete draft* discards it.
- A stage key (e.g. `design`) is permanent once published; reports use it.

## Settings

*Administration → Settings → Job Number*: optionally set a regular expression
the Job Number must match (for example `INV-[0-9]{5}`) and an example shown to
Sales. Leave empty to accept any unique number. Existing jobs are not affected.

## System status and maintenance mode

*Administration → System* (permission *outbox.manage*) shows the health of the
database and background worker, free disk space, background events and the
last backups (database, files, external copy, restore test), with warnings when
something failed or is overdue.

- **Failed background events**: events (mostly notifications) that failed
  after every retry. Fix the cause shown in *Last error*, then press **Retry**.
  Workflow progress never depends on these events, and retrying cannot create
  duplicates.
- **Maintenance mode** (permission *settings.manage*): while on, only
  administrators can use JobFlow; everyone else sees your message and is let
  back in automatically when you turn it off. Use it before updates and
  restores. Both changes are recorded in the audit log.

Backups, restores, updates and rollback are done on the server: see
`docs/maintenance.md`.
