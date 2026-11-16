/** Departments seeded on first install. Names stay editable by administrators. */
export const SEED_DEPARTMENTS = [
  { code: 'SALES', name: 'Sales Team', description: 'Create job briefs, initiate jobs and record customer design approval' },
  { code: 'DESIGN', name: 'Design Team', description: 'Artwork preparation, versions, revisions and design corrections' },
  { code: 'PRO', name: 'PRO Section', description: 'Government and authority approvals, including RTA' },
  { code: 'LOGISTIC', name: 'Logistic Team', description: 'Vehicle schedule and vehicle branding delivery' },
  { code: 'PRODUCTION', name: 'Production Team', description: 'Printing for vehicle branding; production and fabrication for signage' },
  { code: 'INSTALLATION', name: 'Installation Team', description: 'Vehicle wrapping and signage installation' },
  { code: 'QUALITY', name: 'Quality Team', description: 'QC inspection, checklists, pass/fail and rework' },
  { code: 'MANAGEMENT', name: 'Management / Admin', description: 'Oversight and administration' },
] as const;

export type SeedDepartmentCode = (typeof SEED_DEPARTMENTS)[number]['code'];
