import { describe, expect, it } from 'vitest';
import { briefSchemas, createJobSchema, saveTemplateVersionSchema } from './workflow.js';

describe('workflow schemas', () => {
  it('normalises the manual Job Number', () => {
    const r = createJobSchema.parse({ jobNumber: ' inv-2026/0042 ', serviceType: 'VB', title: 'Fleet wrap' });
    expect(r.jobNumber).toBe('INV-2026/0042');
  });

  it('rejects an empty Job Number', () => {
    expect(createJobSchema.safeParse({ jobNumber: '  ', serviceType: 'VB', title: 'x' }).success).toBe(false);
  });

  it('has no customer fields in the Vehicle Branding brief', () => {
    const { draft } = briefSchemas('VB');
    expect(draft.safeParse({ details: { vehicles: [] }, customerName: 'ACME' }).success).toBe(false);
    expect(draft.safeParse({ details: { vehicles: [], customerPhone: '1' } }).success).toBe(false);
  });

  it('accepts a partial brief as a draft but not as complete', () => {
    const { draft, complete } = briefSchemas('SG');
    const partial = { scope: 'Shop front sign', details: { siteName: 'Mall unit 12' } };
    expect(draft.safeParse(partial).success).toBe(true);
    expect(complete.safeParse(partial).success).toBe(false);
    expect(
      complete.safeParse({ ...partial, details: { ...partial.details, dimensions: '6m x 1.2m', specifications: '3D letters, LED' } }).success,
    ).toBe(true);
  });

  it('only allows gates that exist in this phase', () => {
    const stage = { key: 'design', name: 'Design', departmentId: '0197a3c4-0000-7000-8000-000000000001' };
    expect(saveTemplateVersionSchema.safeParse({ stages: [{ ...stage, gateKeys: ['brief.complete'] }] }).success).toBe(true);
    expect(saveTemplateVersionSchema.safeParse({ stages: [{ ...stage, gateKeys: ['quality.passed'] }] }).success).toBe(false);
  });
});
