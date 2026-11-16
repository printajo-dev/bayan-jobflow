# ADR 0006 — Manual Job Number from the ERP invoice
Status: accepted

Sales types the Job Number when creating a job; it is the ERP invoice number,
so every department and the ERP share one reference. The API trims and
upper-cases it and enforces uniqueness with a database unique index (a
duplicate returns a clear 409 error naming the existing job). An optional
format regex lives in `system_settings`. Corrections to a Job Number require
`job.edit_number`, a reason, and are audited; the old number stays in history.
There is no automatic sequence and no ERP integration in the MVP; a future ERP
integration can validate the number against the ERP.
