# User guide — jobs and workflow (Phase 2)

Open JobFlow at `https://<server address>` and sign in with your office account.
What you see depends on your department and role.

## Jobs list

*Jobs* in the left menu lists the jobs you may see:

- **Sales, Design, Production, Installation, Quality**: all jobs (every
  workflow has a stage for your department).
- **PRO and Logistic**: Vehicle Branding jobs only.
- **Management**: all jobs, view only.

Filter by Job Number or title, service type, status, the department currently
working on the job, and priority. *Customer date* sorts by the date promised to
the customer.

## Creating a job (Sales)

1. *Jobs → New job*.
2. Choose **Vehicle Branding** or **Signage**.
3. Type the **Job Number** exactly as on the ERP invoice. It must be unique;
   JobFlow tells you if it is already used and by which job.
4. Give a short title, the priority and, if agreed, the **customer commitment
   date** (the date promised to the customer; internal deadlines are separate).
5. Fill in the brief:
   - *Vehicle Branding*: scope, each vehicle (make/model, year, plate or chassis,
     colour) and the coverage. **No customer details** are entered here.
   - *Signage*: scope, site name and address, access notes, dimensions,
     specifications and quantity.
6. *Create job*. For Signage, open the **Files** tab and upload the drawings and
   specifications (PDF, AI, images, DXF, PSD, EPS, ZIP, Office files).

You can save an incomplete brief. The **Job Brief** stage cannot be completed
until the brief is complete (and, for Signage, at least one file is attached);
the *Brief* tab lists what is missing.

## The workflow

The **Workflow** tab shows every stage in order, who owns it and its status:

| Vehicle Branding | Signage |
|---|---|
| 1 Job Brief — Sales | 1 Job Brief — Sales |
| 2 Design — Design Team | 2 Design — Design Team |
| 3 Government Approval — PRO Section | 3 Production — Production Team |
| 4 Vehicle Schedule — Logistic Team | 4 Installation — Installation Team |
| 5 Print — Production Team | 5 QC Inspection — Quality Team → **job closes** |
| 6 Wrap — Installation Team | |
| 7 QC Inspection — Quality Team | |
| 8 Delivery — Logistic Team → **job closes** | |

The current stage shows its **checklist** and **automatic checks**:

- Department employees and leaders tick checklist items. Each tick records who
  and when.
- Only the department **leader** can press *Complete*. It stays disabled until
  every required item is ticked and every check passes.
- *Put on hold* (with a reason) pauses the stage; *Resume* continues it.

### Returning work for correction

Some stages can send a job back, for example:

- **Government Approval → Design** when an authority rejects the design;
- **QC Inspection → Design, Print or Wrap** (Signage: Design, Production or
  Installation) when an inspection fails.

The leader presses *Return for correction*, chooses the stage and writes the
reason. **Only that stage is redone** (as "round 2", with a fresh checklist).
When it is completed, the job goes **straight back** to the stage that returned
it. Earlier rounds, ticks and reasons stay visible in the timeline.

### Administrator actions

- *Reopen* a completed stage (also on a closed job) with a reason.
- *Complete with exception* when a check cannot be met; the open checks and the
  reason are recorded.

## Job details

- **Edit details** (Sales): title, priority, customer date.
- **Correct Job Number** (Sales Leader): only to fix a wrong invoice number; a
  reason is required and the old number stays in the history.
- **Cancel job** (Sales Leader): with a reason; the workflow stops and the
  history is kept.
- **Activity** lists everything that happened to the job, newest first.

## Interim checklists (until later phases)

Until the artwork, PRO, scheduling, production, QC and delivery screens are
released, those stages are completed by ticking their checklist items (for
example *"Customer approval recorded against the exact artwork version"*).
Each later phase replaces these ticks with the real records and checks.
