import { ActionIcon, Button, Divider, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, Textarea, TextInput } from '@mantine/core';
import { VB_COVERAGE, type ServiceTypeCode } from '@jobflow/shared';
import { COVERAGE } from './format';

export interface Vehicle {
  description: string;
  year?: string | null;
  plateOrChassis?: string | null;
  colour?: string | null;
}

/** Loose form state; the API validates it against the service type's brief schema. */
export interface BriefState {
  scope: string;
  requirements: string;
  notes: string;
  targetDate: string;
  vehicles: Vehicle[];
  coverage: string | null;
  siteName: string;
  siteAddress: string;
  siteAccessNotes: string;
  dimensions: string;
  specifications: string;
  quantity: number | null;
}

export const emptyBrief: BriefState = {
  scope: '',
  requirements: '',
  notes: '',
  targetDate: '',
  vehicles: [{ description: '' }],
  coverage: null,
  siteName: '',
  siteAddress: '',
  siteAccessNotes: '',
  dimensions: '',
  specifications: '',
  quantity: null,
};

const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

export function briefToPayload(code: ServiceTypeCode, b: BriefState): Record<string, unknown> {
  const common = { scope: orNull(b.scope), requirements: orNull(b.requirements), notes: orNull(b.notes), targetDate: orNull(b.targetDate) };
  if (code === 'VB') {
    return {
      ...common,
      details: {
        vehicles: b.vehicles
          .filter((v) => v.description.trim() !== '')
          .map((v) => ({ description: v.description.trim(), year: orNull(v.year ?? ''), plateOrChassis: orNull(v.plateOrChassis ?? ''), colour: orNull(v.colour ?? '') })),
        coverage: b.coverage,
      },
    };
  }
  return {
    ...common,
    details: {
      siteName: orNull(b.siteName),
      siteAddress: orNull(b.siteAddress),
      siteAccessNotes: orNull(b.siteAccessNotes),
      dimensions: orNull(b.dimensions),
      specifications: orNull(b.specifications),
      quantity: b.quantity,
    },
  };
}

export function briefFromDto(brief: Record<string, unknown>): BriefState {
  const d = (brief['details'] ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const vehicles = Array.isArray(d['vehicles']) ? (d['vehicles'] as Vehicle[]) : [];
  return {
    scope: s(brief['scope']),
    requirements: s(brief['requirements']),
    notes: s(brief['notes']),
    targetDate: s(brief['targetDate']),
    vehicles: vehicles.length ? vehicles : [{ description: '' }],
    coverage: typeof d['coverage'] === 'string' ? (d['coverage'] as string) : null,
    siteName: s(d['siteName']),
    siteAddress: s(d['siteAddress']),
    siteAccessNotes: s(d['siteAccessNotes']),
    dimensions: s(d['dimensions']),
    specifications: s(d['specifications']),
    quantity: typeof d['quantity'] === 'number' ? (d['quantity'] as number) : null,
  };
}

export function BriefForm({ code, value, onChange }: { code: ServiceTypeCode; value: BriefState; onChange: (b: BriefState) => void }) {
  const set = <K extends keyof BriefState>(k: K, v: BriefState[K]) => onChange({ ...value, [k]: v });
  const setVehicle = (i: number, patch: Partial<Vehicle>) => set('vehicles', value.vehicles.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <Stack>
      <Textarea label="Scope of work" description="Required to complete the Job Brief stage" autosize minRows={2} value={value.scope} onChange={(e) => set('scope', e.currentTarget.value)} />

      {code === 'VB' ? (
        <>
          <Divider label="Vehicles" labelPosition="left" />
          <Text size="xs" c="dimmed">
            The Vehicle Branding brief is identified by the Job Number. Customer details are not part of the brief.
          </Text>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Make / model</Table.Th>
                <Table.Th w={90}>Year</Table.Th>
                <Table.Th w={160}>Plate or chassis</Table.Th>
                <Table.Th w={120}>Colour</Table.Th>
                <Table.Th w={40} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {value.vehicles.map((v, i) => (
                <Table.Tr key={i}>
                  <Table.Td>
                    <TextInput aria-label={`Vehicle ${i + 1} make and model`} value={v.description} onChange={(e) => setVehicle(i, { description: e.currentTarget.value })} />
                  </Table.Td>
                  <Table.Td>
                    <TextInput aria-label={`Vehicle ${i + 1} year`} value={v.year ?? ''} onChange={(e) => setVehicle(i, { year: e.currentTarget.value })} />
                  </Table.Td>
                  <Table.Td>
                    <TextInput aria-label={`Vehicle ${i + 1} plate`} value={v.plateOrChassis ?? ''} onChange={(e) => setVehicle(i, { plateOrChassis: e.currentTarget.value })} />
                  </Table.Td>
                  <Table.Td>
                    <TextInput aria-label={`Vehicle ${i + 1} colour`} value={v.colour ?? ''} onChange={(e) => setVehicle(i, { colour: e.currentTarget.value })} />
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Remove vehicle ${i + 1}`}
                      disabled={value.vehicles.length === 1}
                      onClick={() => set('vehicles', value.vehicles.filter((_, j) => j !== i))}
                    >
                      ×
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group>
            <Button variant="light" size="xs" onClick={() => set('vehicles', [...value.vehicles, { description: '' }])}>
              Add vehicle
            </Button>
          </Group>
          <Select
            label="Coverage"
            data={VB_COVERAGE.map((c) => ({ value: c, label: COVERAGE[c] ?? c }))}
            value={value.coverage}
            onChange={(v) => set('coverage', v)}
            clearable
            w={260}
          />
        </>
      ) : (
        <>
          <Divider label="Site and specification" labelPosition="left" />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Site name" value={value.siteName} onChange={(e) => set('siteName', e.currentTarget.value)} />
            <TextInput label="Site address" value={value.siteAddress} onChange={(e) => set('siteAddress', e.currentTarget.value)} />
          </SimpleGrid>
          <Textarea label="Site access notes" autosize minRows={1} value={value.siteAccessNotes} onChange={(e) => set('siteAccessNotes', e.currentTarget.value)} />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Textarea label="Dimensions" autosize minRows={2} value={value.dimensions} onChange={(e) => set('dimensions', e.currentTarget.value)} />
            <NumberInput label="Quantity" min={1} value={value.quantity ?? ''} onChange={(v) => set('quantity', typeof v === 'number' ? v : null)} />
          </SimpleGrid>
          <Textarea label="Specifications" autosize minRows={3} value={value.specifications} onChange={(e) => set('specifications', e.currentTarget.value)} />
          <Text size="xs" c="dimmed">
            Attach drawings and specification files on the job page after creating the job.
          </Text>
        </>
      )}

      <Divider label="Other" labelPosition="left" />
      <Textarea label="Requirements" autosize minRows={2} value={value.requirements} onChange={(e) => set('requirements', e.currentTarget.value)} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Target date" type="date" value={value.targetDate} onChange={(e) => set('targetDate', e.currentTarget.value)} />
      </SimpleGrid>
      <Textarea label="Notes" autosize minRows={2} value={value.notes} onChange={(e) => set('notes', e.currentTarget.value)} />
    </Stack>
  );
}
