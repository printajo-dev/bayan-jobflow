import type { PermissionKey, SeedDepartmentCode } from '@jobflow/shared';

export interface SeedRole {
  key: string;
  name: string;
  description: string;
  scope: 'GLOBAL' | 'DEPARTMENT';
  /** For DEPARTMENT roles: the department the role is limited to. */
  department?: SeedDepartmentCode;
  permissions: PermissionKey[];
}

const MEMBER_COMMON: PermissionKey[] = [
  'job.view', 'stage.view', 'task.view', 'task.update_own',
  'channel.view', 'message.post', 'message.voice', 'message.edit_own', 'message.delete_own',
  'correction.create', 'correction.resolve', 'file.upload', 'file.download', 'report.view',
];

const LEADER_EXTRA: PermissionKey[] = [
  'stage.complete', 'stage.hold', 'stage.return',
  'task.create', 'task.assign', 'task.update_any', 'task.set_deadline',
  'correction.assign', 'correction.reopen',
  'message.pin', 'message.moderate', 'channel.add_participant',
];

const DEPARTMENT_SPECIFIC: Record<Exclude<SeedDepartmentCode, 'MANAGEMENT'>, { member: PermissionKey[]; leader: PermissionKey[] }> = {
  SALES: {
    member: ['job.create', 'job.edit_brief', 'job.view_customer', 'customer_approval.record', 'artwork.view', 'vehicle_schedule.view'],
    leader: ['job.cancel', 'job.edit_number'],
  },
  DESIGN: { member: ['artwork.view', 'artwork.upload', 'correction_round.manage'], leader: [] },
  // PRO has no Design permissions; Design has no authority permissions.
  PRO: { member: ['authority.view', 'authority.manage'], leader: ['authority.mark_not_required'] },
  LOGISTIC: {
    member: ['vehicle_schedule.view', 'vehicle_schedule.manage', 'delivery.manage', 'installation.view'],
    leader: [],
  },
  PRODUCTION: { member: ['production.view', 'production.manage', 'artwork.view', 'vehicle_schedule.view'], leader: [] },
  INSTALLATION: {
    member: ['installation.view', 'installation.manage', 'production.view', 'artwork.view', 'vehicle_schedule.view'],
    leader: [],
  },
  QUALITY: { member: ['qc.view', 'qc.inspect', 'qc.approve', 'artwork.view', 'production.view', 'installation.view'], leader: [] },
};

const LABEL: Record<Exclude<SeedDepartmentCode, 'MANAGEMENT'>, string> = {
  SALES: 'Sales',
  DESIGN: 'Design',
  PRO: 'PRO',
  LOGISTIC: 'Logistic',
  PRODUCTION: 'Production',
  INSTALLATION: 'Installation',
  QUALITY: 'Quality',
};

const departmentRoles: SeedRole[] = (Object.keys(DEPARTMENT_SPECIFIC) as (keyof typeof DEPARTMENT_SPECIFIC)[]).flatMap(
  (code) => {
    const spec = DEPARTMENT_SPECIFIC[code];
    const member = [...MEMBER_COMMON, ...spec.member];
    return [
      {
        key: `${code.toLowerCase()}_member`,
        name: `${LABEL[code]} Employee`,
        description: `Works on assigned ${LABEL[code]} tasks and channels`,
        scope: 'DEPARTMENT' as const,
        department: code,
        permissions: member,
      },
      {
        key: `${code.toLowerCase()}_leader`,
        name: `${LABEL[code]} Leader`,
        description: `Assigns ${LABEL[code]} work, sets deadlines and completes ${LABEL[code]} stages`,
        scope: 'DEPARTMENT' as const,
        department: code,
        permissions: [...member, ...LEADER_EXTRA, ...spec.leader],
      },
    ];
  },
);

export const SEED_ROLES: SeedRole[] = [
  {
    key: 'system_admin',
    name: 'System Administrator',
    description: 'System configuration, users, roles, permissions, workflow templates and settings',
    scope: 'GLOBAL',
    permissions: [
      'user.manage', 'role.manage', 'department.manage', 'template.manage', 'settings.manage',
      'audit.view', 'outbox.manage', 'report.view', 'report.export',
      'job.view', 'job.create', 'job.edit_brief', 'job.edit_number', 'job.cancel', 'job.view_customer',
      'stage.view', 'stage.complete', 'stage.hold', 'stage.return', 'stage.reopen', 'stage.exception',
      'task.view', 'task.assign', 'task.set_deadline',
      'authority.view', 'authority.mark_not_required',
      'channel.view', 'message.post', 'correction.create', 'file.download',
    ],
  },
  {
    key: 'management',
    name: 'Management',
    description: 'View-only access to all jobs, stages, channels and reports',
    scope: 'GLOBAL',
    permissions: [
      'job.view', 'job.view_customer', 'stage.view', 'task.view', 'artwork.view', 'authority.view',
      'vehicle_schedule.view', 'production.view', 'installation.view', 'qc.view', 'channel.view',
      'file.download', 'report.view', 'report.export',
    ],
  },
  ...departmentRoles,
];
