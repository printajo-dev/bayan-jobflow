/**
 * Every permission the application checks. The API seeds these into the
 * `permissions` table; administrators grant them to roles. Never rename a key
 * without a migration: roles reference them by key.
 */
export const PERMISSIONS = [
  // Jobs
  { key: 'job.view', area: 'Jobs', description: 'View jobs and job briefs' },
  { key: 'job.create', area: 'Jobs', description: 'Create jobs (enter the Job Number)' },
  { key: 'job.edit_number', area: 'Jobs', description: 'Correct a Job Number (reason required, audited)' },
  { key: 'job.edit_brief', area: 'Jobs', description: 'Edit job briefs' },
  { key: 'job.cancel', area: 'Jobs', description: 'Cancel jobs' },
  { key: 'job.view_customer', area: 'Jobs', description: 'View optional customer details' },
  // Workflow
  { key: 'stage.view', area: 'Workflow', description: 'View workflow stages' },
  { key: 'stage.complete', area: 'Workflow', description: 'Complete a stage' },
  { key: 'stage.hold', area: 'Workflow', description: 'Put a stage on hold' },
  { key: 'stage.return', area: 'Workflow', description: 'Return a job to an earlier stage for correction' },
  { key: 'stage.reopen', area: 'Workflow', description: 'Reopen a completed stage' },
  { key: 'stage.exception', area: 'Workflow', description: 'Record a workflow exception' },
  // Tasks
  { key: 'task.view', area: 'Tasks', description: 'View tasks' },
  { key: 'task.create', area: 'Tasks', description: 'Create tasks' },
  { key: 'task.assign', area: 'Tasks', description: 'Assign employees to tasks' },
  { key: 'task.update_own', area: 'Tasks', description: 'Update tasks assigned to me' },
  { key: 'task.update_any', area: 'Tasks', description: 'Update any task in my scope' },
  { key: 'task.set_deadline', area: 'Tasks', description: 'Set internal deadlines' },
  // Design
  { key: 'artwork.view', area: 'Design', description: 'View artwork versions' },
  { key: 'artwork.upload', area: 'Design', description: 'Upload artwork versions' },
  { key: 'correction_round.manage', area: 'Design', description: 'Manage design correction rounds' },
  { key: 'customer_approval.record', area: 'Design', description: 'Record customer approval of an artwork version' },
  // PRO
  { key: 'authority.view', area: 'PRO', description: 'View authority applications' },
  { key: 'authority.manage', area: 'PRO', description: 'Create and update authority applications' },
  { key: 'authority.mark_not_required', area: 'PRO', description: 'Mark an authority approval Not Required (reason required)' },
  // Logistic
  { key: 'vehicle_schedule.view', area: 'Logistic', description: 'View vehicle schedules' },
  { key: 'vehicle_schedule.manage', area: 'Logistic', description: 'Manage vehicle schedules' },
  { key: 'delivery.manage', area: 'Logistic', description: 'Record deliveries' },
  // Production
  { key: 'production.view', area: 'Production', description: 'View production orders' },
  { key: 'production.manage', area: 'Production', description: 'Manage production orders and logs' },
  // Installation
  { key: 'installation.view', area: 'Installation', description: 'View installation orders' },
  { key: 'installation.manage', area: 'Installation', description: 'Manage installation orders and logs' },
  // Quality
  { key: 'qc.view', area: 'Quality', description: 'View QC inspections' },
  { key: 'qc.inspect', area: 'Quality', description: 'Perform QC inspections' },
  { key: 'qc.approve', area: 'Quality', description: 'Pass or fail QC inspections' },
  // Discussions
  { key: 'channel.view', area: 'Discussions', description: 'Read department channels I have access to' },
  { key: 'message.post', area: 'Discussions', description: 'Post messages and attachments' },
  { key: 'message.voice', area: 'Discussions', description: 'Record and upload voice notes' },
  { key: 'message.edit_own', area: 'Discussions', description: 'Edit my own messages' },
  { key: 'message.delete_own', area: 'Discussions', description: 'Delete my own messages' },
  { key: 'message.moderate', area: 'Discussions', description: 'Edit or delete any message in my scope' },
  { key: 'message.pin', area: 'Discussions', description: 'Pin messages' },
  { key: 'channel.add_participant', area: 'Discussions', description: 'Add cross-department participants' },
  // Corrections
  { key: 'correction.create', area: 'Corrections', description: 'Create correction items' },
  { key: 'correction.assign', area: 'Corrections', description: 'Assign correction items' },
  { key: 'correction.resolve', area: 'Corrections', description: 'Resolve correction items' },
  { key: 'correction.reopen', area: 'Corrections', description: 'Reopen correction items' },
  // Files
  { key: 'file.upload', area: 'Files', description: 'Upload files' },
  { key: 'file.download', area: 'Files', description: 'Download and preview files' },
  { key: 'file.delete', area: 'Files', description: 'Delete files (soft delete)' },
  // Reports
  { key: 'report.view', area: 'Reports', description: 'View dashboards and reports' },
  { key: 'report.export', area: 'Reports', description: 'Export reports' },
  // Administration
  { key: 'user.manage', area: 'Administration', description: 'Manage users, passwords and account status' },
  { key: 'role.manage', area: 'Administration', description: 'Manage roles and permissions' },
  { key: 'department.manage', area: 'Administration', description: 'Manage departments' },
  { key: 'template.manage', area: 'Administration', description: 'Manage workflow templates' },
  { key: 'settings.manage', area: 'Administration', description: 'Manage system settings' },
  { key: 'audit.view', area: 'Administration', description: 'View the audit log' },
  { key: 'outbox.manage', area: 'Administration', description: 'View and retry failed background events' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}
