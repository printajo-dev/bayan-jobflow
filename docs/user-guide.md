# User guide

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

## Tasks (Tasks tab, *My work*)

- Leaders press *Add task* on a stage of their department, choose employees
  of the department, a due date (the employee deadline), dependencies and an
  optional checklist. *Required* tasks must be finished before the stage can be
  completed.
- Leaders also set the stage's **internal deadline** on the Workflow tab. It is
  separate from the customer date, which only Sales changes.
- Employees see their tasks under *My work* and move them through To do →
  In progress → Completed. Leaders can cancel or reopen a task with a reason.

## Design & approvals

- Designers upload artwork with *Upload new version*. Every upload is a new
  version; nothing is ever overwritten.
- Sales records the customer's approval with *Record customer approval*: who
  approved, how (email, WhatsApp, phone, in person, signed form), when, notes and
  evidence. Approval belongs to that exact version: after a new upload, a new
  approval is needed before Design can be completed.
- *New correction round* records what the customer wants changed; the next
  upload can be marked as resolving that round.

## Discussions

Each job has a channel per department plus *General*. You see your
department's channel and General; leaders can add a person from another
department to one channel. Write messages, reply in threads, attach files,
record a **voice note** (🎤, up to 10 minutes; your browser asks for the
microphone the first time), mention colleagues, react, and search. Edited and
deleted messages keep their history. *Make correction* turns a message into a
formal correction.

## Corrections

A correction is a tracked request to fix something, assigned to a department
and usually a person. It moves Open → Assigned → In progress → Resolved (with
notes and evidence) and can be reopened. A *blocking* correction stops the
department's stage until it is resolved.

## Notifications

The bell shows unread notifications (assignments, mentions, replies, stages
starting or returned, approvals, corrections, due and overdue tasks). Choose
what you want to be told about at the bottom of the Notifications page.

## PRO approvals (Vehicle Branding)

The **PRO approvals** tab lists the authority applications for the job.
PRO adds each required authority (e.g. RTA), records the submission
(reference number, date, fees), the authority's decision, payments and
documents. An application is only *Approved* after the approval document is
attached. A rejection keeps the earlier submission; resubmit after Design has
made the change (use *Return for correction* on the Government Approval stage
to send the job back to Design). If an authority is not needed for this job,
the PRO Leader (or an administrator) uses *Mark Not Required* with a reason.
Print and Wrap cannot start until every application is Approved or Not
Required.

## Operations

- **Vehicle schedule** (Logistic, Vehicle Branding only): propose date, time,
  vehicle and place; press *Confirm availability* only after the customer has
  confirmed the vehicle, and note who confirmed. Changing a confirmed schedule
  needs a reason and a new confirmation; Design, Production and Installation
  leaders are told automatically.
- **Production**: plan production orders (activity, material, quantity, machine,
  operator, times). Add progress logs with photos; an order can only be
  completed after a log with evidence. Vehicle Branding always prints the
  latest customer-approved artwork.
- **Installation**: plan the installation (vehicle or site, address, access and
  safety notes, team leader, technicians, materials). Technicians add progress
  logs; completion needs a log with photos. Use *Blocked* or *Partial* with a
  description when work cannot finish.

## QC inspection

The Quality Team opens the **QC** tab and presses *Start inspection*. Each
checklist item is marked Pass, Fail or N/A (N/A on a required item needs a
comment); items marked "photo required" need a photo.

- *Pass inspection*: the QC stage completes at once. A Signage job closes; a
  Vehicle Branding job moves to Delivery.
- *Fail inspection*: describe the defects and choose which stage must redo the
  work (for example Wrap). JobFlow creates a blocking correction for that
  department, sends the job back to that stage only, and QC inspects again
  afterwards. The failed inspection stays in the history.

## Delivery (Vehicle Branding)

Logistic plans the delivery on the **Delivery** tab, and after the handover
presses *Record handover* with the recipient's name, notes and photos or a
signed handover note. The job then closes.
