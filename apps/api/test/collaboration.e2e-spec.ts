import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { io as connect } from 'socket.io-client';
import type { ChannelDto, MessageDto, TaskDto } from '@jobflow/shared';
import { API, createTestApp } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/core/prisma.service.js';
import { RealtimeService } from '../src/realtime/realtime.service.js';
import { OutboxRelay } from '../src/outbox/outbox.relay.js';
import { Notifier } from '../src/notifications/notifier.js';
import { Actors, COMPLETE_VB_BRIEF, PDF } from './workflow-helpers.js';

const VOICE = readFileSync(new URL('./fixtures/voice-3s.webm', import.meta.url));

describe('Phase 3: tasks, design approval, discussions, corrections, notifications', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: Actors;
  const ids = async (u: string) => (await prisma.user.findUniqueOrThrow({ where: { username: u } })).id;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'system_admin' } });
    await prisma.user.upsert({
      where: { username: 'admin.helper' },
      create: { username: 'admin.helper', fullName: 'Helper Admin', passwordHash: await hashPassword('Demo-Password-2026'), roles: { create: [{ roleId: role.id }] } },
      update: {},
    });
    as = new Actors(app);
  });
  afterAll(async () => app.close());

  async function channels(jobId: string, user: string): Promise<ChannelDto[]> {
    const r = await as.get(user, `/jobs/${jobId}/discussions`);
    expect(r.status).toBe(200);
    return r.body;
  }

  describe('design, artwork versions and customer approval (AT7, AT9, AT10)', () => {
    it('only design and sales roles can see design work; PRO cannot, even through the API', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      expect((await as.get('demo.design', `/jobs/${job.id}/design`)).status).toBe(200);
      expect((await as.get('demo.sales', `/jobs/${job.id}/design`)).status).toBe(200);
      expect((await as.get('demo.pro.lead', `/jobs/${job.id}/design`)).status).toBe(403);
      const pro = await as.as('demo.pro.lead');
      const up = await pro.agent.post(`${API}/jobs/${job.id}/artwork-versions`).set('X-CSRF-Token', pro.csrf).attach('file', PDF, 'a.pdf');
      expect(up.status).toBe(403);
      const sales = await as.as('demo.sales');
      expect((await sales.agent.post(`${API}/jobs/${job.id}/artwork-versions`).set('X-CSRF-Token', sales.csrf).attach('file', PDF, 'a.pdf')).status).toBe(403);
    });

    it('keeps every version, ties approval to the exact version, and needs a new approval after a change', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      await as.completeCurrent(job.id); // brief
      const v1 = await as.approveArtwork(job.id, 'proof-v1.pdf');
      let wf = await as.workflow(job.id);
      expect(as.current(wf).gates.find((g) => g.key === 'design.customer_approval')?.passed).toBe(true);

      const d = await as.as('demo.design.lead');
      const v2 = await d.agent.post(`${API}/jobs/${job.id}/artwork-versions`).set('X-CSRF-Token', d.csrf).attach('file', Buffer.concat([PDF, Buffer.from('% v2')]), 'proof-v2.pdf');
      expect(v2.status).toBe(201);
      expect(v2.body.versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1]);
      expect(v2.body.latestApproved).toBe(false);
      wf = await as.workflow(job.id);
      expect(as.current(wf).gates.find((g) => g.key === 'design.customer_approval')).toMatchObject({ passed: false });
      expect((await as.post('demo.design.lead', `/jobs/${job.id}/stages/${as.current(wf).id}/complete`)).status).toBe(422);

      // Approving the superseded version is refused.
      const stale = await as.post('demo.sales', `/artwork-versions/${v1}/approval-records`, { approverName: 'X', method: 'PHONE', approvedAt: new Date().toISOString() });
      expect(stale.status).toBe(409);
      // Approval is never assumed and cannot be recorded by Design.
      expect((await as.post('demo.design.lead', `/artwork-versions/${v2.body.versions[0].id}/approval-records`, { approverName: 'X', method: 'PHONE', approvedAt: new Date().toISOString() })).status).toBe(403);

      // Evidence file + approval of the latest version.
      const s = await as.as('demo.sales');
      const ev = await s.agent.post(`${API}/jobs/${job.id}/design-files?kind=evidence`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'email-screenshot.pdf');
      expect(ev.status).toBe(201);
      const ok = await as.post('demo.sales', `/artwork-versions/${v2.body.versions[0].id}/approval-records`, {
        approverName: 'Ahmed (fleet manager)',
        approverRole: 'Customer',
        method: 'EMAIL',
        approvedAt: new Date(Date.now() - 3600_000).toISOString(),
        notes: 'Approved by email',
        evidenceFileId: ev.body.id,
      });
      expect(ok.status).toBe(201);
      expect(ok.body.versions[0].approvals[0]).toMatchObject({ versionNo: 2, approverName: 'Ahmed (fleet manager)', method: 'EMAIL', evidenceFile: { originalName: 'email-screenshot.pdf' } });
      expect(ok.body.versions[1].approvals).toHaveLength(1);

      // Both files remain downloadable; history cannot be altered.
      for (const v of ok.body.versions) expect((await as.get('demo.design', `/files/${v.file.id}/download`)).status).toBe(200);
      expect((await as.get('demo.pro.lead', `/files/${ok.body.versions[0].file.id}/download`)).status).toBe(404);
      await expect(prisma.artworkVersion.delete({ where: { id: v1 } })).rejects.toThrow();
      await expect(prisma.approvalRecord.updateMany({ where: { jobId: job.id }, data: { approverName: 'Forged' } })).rejects.toThrow();

      wf = await as.completeCurrent(job.id);
      expect(as.current(wf).key).toBe('government_approval');
    });

    it('opens design correction rounds and resolves them with a new version', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const designer = await ids('demo.design');
      const r = await as.post('demo.sales', `/jobs/${job.id}/correction-rounds`, { description: 'Make the logo 20% larger', assignedDesignerId: designer, deadline: '2030-01-01' });
      expect(r.status).toBe(201);
      const round = r.body.rounds[0];
      expect(round).toMatchObject({ roundNo: 1, status: 'OPEN', assignedDesigner: { id: designer } });
      const d = await as.as('demo.design.lead');
      const v = await d.agent.post(`${API}/jobs/${job.id}/artwork-versions`).set('X-CSRF-Token', d.csrf).field('correctionRoundId', round.id).attach('file', PDF, 'v-fix.pdf');
      expect(v.status).toBe(201);
      expect(v.body.rounds[0]).toMatchObject({ status: 'RESOLVED', resolvedByVersionNo: 1 });
      expect(v.body.versions[0].correctionRoundNo).toBe(1);
    });
  });

  describe('tasks and deadlines (AT11)', () => {
    it('leaders assign department members manually, set internal deadlines, and required tasks block the stage', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF, { customerCommitmentDate: '2030-06-30' });
      await as.completeCurrent(job.id);
      let wf = await as.workflow(job.id);
      const design = as.current(wf);
      const member = await ids('demo.design');
      const proMember = await ids('demo.pro');

      expect((await as.post('demo.design', `/jobs/${job.id}/tasks`, { stageId: design.id, title: 'x' })).status).toBe(403);
      expect((await as.post('demo.design.lead', `/jobs/${job.id}/tasks`, { stageId: design.id, title: 'x', assigneeIds: [proMember] })).status).toBe(400);

      const t1 = (await as.post('demo.design.lead', `/jobs/${job.id}/tasks`, { stageId: design.id, title: 'Prepare proof', assigneeIds: [member], dueDate: '2030-06-01', checklist: ['Check vehicle templates'] })).body as TaskDto;
      expect(t1).toMatchObject({ status: 'ASSIGNED', assignees: [{ id: member }], dueDate: '2030-06-01', required: true });
      const t2 = (await as.post('demo.design.lead', `/jobs/${job.id}/tasks`, { stageId: design.id, title: 'Final export', dependsOnIds: [t1.id] })).body as TaskDto;
      expect(t2.status).toBe('TODO');

      const dl = await as.as('demo.design.lead');
      await dl.agent.put(`${API}/jobs/${job.id}/stages/${design.id}/deadline`).set('X-CSRF-Token', dl.csrf).send({ internalDeadline: '2030-05-15' }).expect(204);
      wf = await as.workflow(job.id);
      expect(as.current(wf).internalDeadline).toBe('2030-05-15');
      expect((await as.get('demo.sales', `/jobs/${job.id}`)).body.customerCommitmentDate).toBe('2030-06-30');

      await as.approveArtwork(job.id);
      const blocked = await as.post('demo.design.lead', `/jobs/${job.id}/stages/${design.id}/complete`);
      expect(blocked.status).toBe(422);
      expect(blocked.body.message.join(' ')).toMatch(/Prepare proof/);

      // Dependency and checklist enforcement; the assignee updates their own task.
      expect((await as.patch('demo.design.lead', `/tasks/${t2.id}`, { status: 'COMPLETED' })).status).toBe(409);
      expect((await as.patch('demo.design', `/tasks/${t1.id}`, { title: 'Renamed' })).status).toBe(403);
      expect((await as.patch('demo.design', `/tasks/${t1.id}`, { status: 'COMPLETED' })).status).toBe(409);
      await as.post('demo.design', `/tasks/${t1.id}/checklist/${t1.checklist[0]!.id}`, { done: true }).then((r) => expect(r.status).toBe(200));
      const done = await as.patch('demo.design', `/tasks/${t1.id}`, { status: 'COMPLETED' });
      expect(done.body).toMatchObject({ status: 'COMPLETED', completedBy: 'Design Employee' });
      expect((await as.patch('demo.design.lead', `/tasks/${t2.id}`, { status: 'CANCELLED' })).status).toBe(400);
      expect((await as.patch('demo.design.lead', `/tasks/${t2.id}`, { status: 'CANCELLED', reason: 'Not needed' })).body.status).toBe('CANCELLED');

      const c = await as.post('demo.design', `/tasks/${t1.id}/comments`, { body: 'Uploaded the proof' });
      expect(c.body.comments).toHaveLength(1);
      expect((await as.get('demo.design', '/tasks?mine=true&status=all')).body.items.some((t: TaskDto) => t.id === t1.id)).toBe(true);

      wf = (await as.post('demo.design.lead', `/jobs/${job.id}/stages/${design.id}/complete`)).body;
      expect(as.current(wf).key).toBe('government_approval');
      const history = (await as.get('demo.sales', `/jobs/${job.id}/activity?pageSize=100`)).body.items.map((i: { action: string }) => i.action);
      expect(history).toEqual(expect.arrayContaining(['task.created', 'task.completed', 'task.cancelled', 'stage.deadline_set']));
    });
  });

  describe('department discussions (AT12, AT13, AT14)', () => {
    it('creates one channel per stage department plus General; users only see channels they may read', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const all = await channels(job.id, 'admin.helper');
      expect(all.map((c) => c.name).sort((a, b) => a.localeCompare(b))).toEqual(
        ['Design Team', 'General', 'Installation Team', 'Logistic Team', 'PRO Section', 'Production Team', 'Quality Team', 'Sales Team'].sort((a, b) => a.localeCompare(b)),
      );
      expect((await channels(job.id, 'demo.design')).map((c) => c.name).sort((a, b) => a.localeCompare(b))).toEqual(['Design Team', 'General']);
      const mgmt = await channels(job.id, 'demo.management');
      expect(mgmt).toHaveLength(8);
      expect(mgmt.every((c) => !c.canPost)).toBe(true);

      const proChannel = all.find((c) => c.name === 'PRO Section')!;
      expect((await as.get('demo.design', `/discussions/${proChannel.id}/messages`)).status).toBe(404);
      expect((await as.post('demo.design', `/discussions/${proChannel.id}/messages`, { body: 'hi' })).status).toBe(404);
    });

    it('supports threads, attachments, voice notes, mentions, reactions, pins, read receipts and search', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const design = (await channels(job.id, 'demo.design.lead')).find((c) => c.name === 'Design Team')!;
      const lead = await as.as('demo.design.lead');

      const file = await lead.agent.post(`${API}/discussions/${design.id}/attachments`).set('X-CSRF-Token', lead.csrf).attach('file', PDF, 'reference.pdf');
      expect(file.status).toBe(201);
      const voice = await lead.agent.post(`${API}/discussions/${design.id}/attachments?voice=1&durationSec=3`).set('X-CSRF-Token', lead.csrf).attach('file', VOICE, 'note.webm');
      expect(voice.status).toBe(201);
      expect(voice.body).toMatchObject({ mimeType: 'audio/webm', durationSec: 3 });
      const notAudio = await lead.agent.post(`${API}/discussions/${design.id}/attachments?voice=1`).set('X-CSRF-Token', lead.csrf).attach('file', PDF, 'fake.webm');
      expect(notAudio.status).toBe(400);

      const member = await ids('demo.design');
      const root = await as.post('demo.design.lead', `/discussions/${design.id}/messages`, {
        body: 'Please check the attached reference and my voice note',
        fileIds: [file.body.id, voice.body.id],
        mentionUserIds: [member],
      });
      expect(root.status).toBe(201);
      expect(root.body.attachments).toHaveLength(2);
      expect(root.body.attachments.find((a: { isVoice: boolean }) => a.isVoice)).toMatchObject({ durationSec: 3 });
      // Attachments cannot be reused in another message.
      expect((await as.post('demo.design.lead', `/discussions/${design.id}/messages`, { body: 'again', fileIds: [file.body.id] })).status).toBe(400);
      // Mentioning someone who cannot read the channel is refused.
      expect((await as.post('demo.design.lead', `/discussions/${design.id}/messages`, { body: 'hi', mentionUserIds: [await ids('demo.pro')] })).status).toBe(400);

      const unreadBefore = (await channels(job.id, 'demo.design')).find((c) => c.id === design.id)!.unread;
      expect(unreadBefore).toBeGreaterThanOrEqual(1);
      const reply = await as.post('demo.design', `/discussions/${design.id}/messages`, { body: 'On it', parentMessageId: root.body.id });
      expect(reply.body.parentMessageId).toBe(root.body.id);
      await as.post('demo.design', `/discussions/${design.id}/read`);
      expect((await channels(job.id, 'demo.design')).find((c) => c.id === design.id)!.unread).toBe(0);

      const top = (await as.get('demo.design', `/discussions/${design.id}/messages`)).body as MessageDto[];
      const rootDto = top.find((m) => m.id === root.body.id)!;
      expect(rootDto).toMatchObject({ replyCount: 1 });
      expect(rootDto.readBy).toBeGreaterThanOrEqual(2);
      const thread = (await as.get('demo.design', `/discussions/${design.id}/messages?parentMessageId=${root.body.id}`)).body as MessageDto[];
      expect(thread.map((m) => m.body)).toEqual(['On it']);

      const reacted = await as.post('demo.design', `/messages/${root.body.id}/reactions`, { emoji: '👍' });
      expect(reacted.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
      expect((await as.post('demo.design', `/messages/${root.body.id}/pin`)).status).toBe(403);
      expect((await as.post('demo.design.lead', `/messages/${root.body.id}/pin`)).body.pinned).toBe(true);
      expect((await as.get('demo.design', `/discussions/${design.id}/pins`)).body).toHaveLength(1);
      const found = (await as.get('demo.design', `/discussions/${design.id}/messages?q=reference`)).body as MessageDto[];
      expect(found.map((m) => m.id)).toContain(root.body.id);

      // Voice note playback: channel readers yes, other departments no.
      expect((await as.get('demo.design', `/files/${voice.body.id}/download?inline=1`)).headers['content-type']).toMatch(/audio\/webm/);
      expect((await as.get('demo.pro.lead', `/files/${voice.body.id}/download`)).status).toBe(404);
      expect((await as.get('demo.sales', `/files/${voice.body.id}/download`)).status).toBe(404);
    });

    it('rejects voice notes longer than ten minutes', async () => {
      const path = join(tmpdir(), `long-${Date.now()}.webm`);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '620', '-c:a', 'libopus', '-b:a', '6k', path]);
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const design = (await channels(job.id, 'demo.design')).find((c) => c.name === 'Design Team')!;
      const s = await as.as('demo.design');
      const r = await s.agent.post(`${API}/discussions/${design.id}/attachments?voice=1`).set('X-CSRF-Token', s.csrf).attach('file', readFileSync(path), 'long.webm');
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/10 minutes/);
    });

    it('keeps edit and delete history', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const general = (await channels(job.id, 'demo.sales')).find((c) => c.type === 'GENERAL')!;
      const m = (await as.post('demo.sales', `/discussions/${general.id}/messages`, { body: 'Customer wants blue' })).body as MessageDto;
      expect((await as.patch('demo.design', `/messages/${m.id}`, { body: 'hijack' })).status).toBe(403);
      const edited = await as.patch('demo.sales', `/messages/${m.id}`, { body: 'Customer wants dark blue' });
      expect(edited.body).toMatchObject({ body: 'Customer wants dark blue', edited: true });
      const s = await as.as('demo.sales');
      await s.agent.delete(`${API}/messages/${m.id}`).set('X-CSRF-Token', s.csrf).expect(204);
      const list = (await as.get('demo.sales', `/discussions/${general.id}/messages`)).body as MessageDto[];
      expect(list.find((x) => x.id === m.id)).toMatchObject({ deleted: true, body: '' });
      const history = await as.get('admin.helper', `/messages/${m.id}/history`);
      expect(history.body.map((h: { action: string; previousBody: string }) => [h.action, h.previousBody])).toEqual([
        ['edit', 'Customer wants blue'],
        ['delete', 'Customer wants dark blue'],
      ]);
      expect((await as.get('demo.sales', `/messages/${m.id}/history`)).status).toBe(403);
      await expect(prisma.discussionMessage.delete({ where: { id: m.id } })).rejects.toThrow();
    });

    it('posts system messages for stage changes and lets administrators add channels and leaders add participants', async () => {
      const job = await as.createJob('SG', { scope: 'x', details: { siteName: 'Mall', dimensions: '1x1', specifications: 'LED' } });
      const admin = await as.as('admin.helper');
      const depts = (await admin.agent.get(`${API}/departments`)).body as { id: string; code: string }[];
      const logistic = depts.find((d) => d.code === 'LOGISTIC')!;
      expect((await channels(job.id, 'admin.helper')).some((c) => c.name === 'Logistic Team')).toBe(false);
      expect((await as.post('demo.sales.lead', `/jobs/${job.id}/discussions`, { departmentId: logistic.id })).status).toBe(403);
      expect((await as.post('admin.helper', `/jobs/${job.id}/discussions`, { departmentId: logistic.id })).status).toBe(201);

      const design = (await channels(job.id, 'demo.design.lead')).find((c) => c.name === 'Design Team')!;
      const salesUser = await ids('demo.sales');
      expect((await as.post('demo.design', `/discussions/${design.id}/participants`, { userId: salesUser })).status).toBe(403);
      expect((await as.post('demo.design.lead', `/discussions/${design.id}/participants`, { userId: salesUser })).status).toBe(201);
      expect((await as.get('demo.sales', `/discussions/${design.id}/messages`)).status).toBe(200);
      // A participant gets access to that channel only, not the whole department.
      const production = (await channels(job.id, 'admin.helper')).find((c) => c.name === 'Production Team')!;
      expect((await as.get('demo.sales', `/discussions/${production.id}/messages`)).status).toBe(404);
    });

    it('delivers new messages live to authorised sockets only', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      const design = (await channels(job.id, 'demo.design')).find((c) => c.name === 'Design Team')!;
      const server = app.getHttpServer();
      await app.get(RealtimeService).attach(server);
      await new Promise<void>((r) => server.listen(0, r));
      const port = (server.address() as AddressInfo).port;
      const cookieOf = async (u: string) => {
        const res = await (await import('supertest')).default(server).post(`${API}/auth/login`).send({ username: u, password: 'Demo-Password-2026' });
        return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
      };
      const designSock = connect(`http://127.0.0.1:${port}`, { path: '/socket.io', transports: ['websocket'], extraHeaders: { Cookie: await cookieOf('demo.design') } });
      const proSock = connect(`http://127.0.0.1:${port}`, { path: '/socket.io', transports: ['websocket'], extraHeaders: { Cookie: await cookieOf('demo.pro') } });
      const anon = connect(`http://127.0.0.1:${port}`, { path: '/socket.io', transports: ['websocket'] });
      const anonError = new Promise<string>((r) => anon.on('connect_error', (e) => r(e.message)));
      const joined = await new Promise<boolean>((r) => designSock.emit('channel:join', design.id, r));
      const proJoined = await new Promise<boolean>((r) => proSock.emit('channel:join', design.id, r));
      expect(joined).toBe(true);
      expect(proJoined).toBe(false);
      expect(await anonError).toBe('unauthorized');
      const received = new Promise<MessageDto>((r) => designSock.on('message:created', r));
      let proGot = false;
      proSock.on('message:created', () => (proGot = true));
      await as.post('demo.design.lead', `/discussions/${design.id}/messages`, { body: 'live!' });
      expect((await received).body).toBe('live!');
      expect(proGot).toBe(false);
      designSock.close();
      proSock.close();
      anon.close();
    });
  });

  describe('formal corrections (AT15)', () => {
    it('converts a comment into a correction that is assigned, tracked, resolved and reopened, and blocks the stage while open', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      await as.completeCurrent(job.id);
      const design = (await channels(job.id, 'demo.design.lead')).find((c) => c.name === 'Design Team')!;
      const msg = (await as.post('demo.design.lead', `/discussions/${design.id}/messages`, { body: 'The QR code is too small' })).body as MessageDto;
      const designDept = design.department!.id;
      const member = await ids('demo.design');
      const c = await as.post('demo.design.lead', '/corrections', {
        jobId: job.id,
        departmentId: designDept,
        sourceMessageId: msg.id,
        title: 'Enlarge QR code',
        description: 'Minimum 3 cm',
        assignedToId: member,
        deadline: '2030-01-10',
      });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ status: 'ASSIGNED', blocking: true, channelId: design.id, sourceMessageId: msg.id, assignedTo: { id: member } });

      await as.approveArtwork(job.id);
      const wf = await as.workflow(job.id);
      const blocked = await as.post('demo.design.lead', `/jobs/${job.id}/stages/${as.current(wf).id}/complete`);
      expect(blocked.status).toBe(422);
      expect(blocked.body.message.join(' ')).toMatch(/Enlarge QR code/);

      expect((await as.post('demo.pro.lead', `/corrections/${c.body.id}/resolve`, { notes: 'x' })).status).toBe(403);
      await as.patch('demo.design', `/corrections/${c.body.id}`, { status: 'IN_PROGRESS' }).then((r) => expect(r.body.status).toBe('IN_PROGRESS'));
      const s = await as.as('demo.design');
      const evidence = await s.agent.post(`${API}/jobs/${job.id}/correction-files`).set('X-CSRF-Token', s.csrf).attach('file', PDF, 'fixed.pdf');
      const resolved = await as.post('demo.design', `/corrections/${c.body.id}/resolve`, { notes: 'QR now 3.5 cm', fileIds: [evidence.body.id] });
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionNotes: 'QR now 3.5 cm', resolvedBy: 'Design Employee' });
      expect(resolved.body.files).toEqual([expect.objectContaining({ originalName: 'fixed.pdf', kind: 'RESOLUTION' })]);

      const reopened = await as.post('demo.design.lead', `/corrections/${c.body.id}/reopen`, { reason: 'Still unreadable on the rear door' });
      expect(reopened.body.status).toBe('REOPENED');
      expect(reopened.body.history.map((h: { to: string }) => h.to)).toEqual(['ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'REOPENED']);
      await expect(prisma.correctionStatusHistory.deleteMany({ where: { correctionId: c.body.id } })).rejects.toThrow();
    });
  });

  describe('notifications', () => {
    it('notifies the right people once per event and respects preferences', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      await as.completeCurrent(job.id);
      const wf = await as.workflow(job.id);
      const member = await ids('demo.design');
      await as.post('demo.design.lead', `/jobs/${job.id}/tasks`, { stageId: as.current(wf).id, title: 'Notify me', assigneeIds: [member] });
      const design = (await channels(job.id, 'demo.design.lead')).find((c) => c.name === 'Design Team')!;
      await as.post('demo.design.lead', `/discussions/${design.id}/messages`, { body: 'Look at this', mentionUserIds: [member] });

      const pushed: string[] = [];
      const relay = new OutboxRelay(prisma, { maxAttempts: 3 });
      const notifier = new Notifier(prisma, { toUser: (u) => pushed.push(u) });
      for (const t of Notifier.EVENTS) relay.on(t, (e) => notifier.handle(e));
      while ((await relay.runOnce()) > 0) {
        /* drain */
      }
      const mine = (await as.get('demo.design', '/notifications?pageSize=100')).body;
      const forJob = mine.items.filter((n: { jobNumber: string }) => n.jobNumber === job.jobNumber);
      expect(forJob.map((n: { type: string }) => n.type)).toEqual(expect.arrayContaining(['task.assigned', 'mention']));
      expect(pushed).toContain(member);
      const leaderNotes = (await as.get('demo.design.lead', '/notifications?pageSize=100')).body.items.filter((n: { jobNumber: string; type: string }) => n.jobNumber === job.jobNumber);
      expect(leaderNotes.some((n: { type: string }) => n.type === 'stage.activated')).toBe(true);

      // Replaying an event cannot duplicate notifications.
      const ev = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: job.id, type: 'task.assigned' } });
      await notifier.handle({ id: ev.id, type: ev.type, aggregate_type: ev.aggregateType, aggregate_id: ev.aggregateId, payload: ev.payload, attempts: 1 });
      const after = (await as.get('demo.design', '/notifications?pageSize=100')).body.items.filter((n: { jobNumber: string; type: string }) => n.jobNumber === job.jobNumber && n.type === 'task.assigned');
      expect(after).toHaveLength(1);

      const s = await as.as('demo.design');
      await s.agent.post(`${API}/notifications/${after[0].id}/read`).set('X-CSRF-Token', s.csrf).expect(204);
      await s.agent.put(`${API}/notifications/preferences`).set('X-CSRF-Token', s.csrf).send({ disabled: ['mention'] }).expect(200);
      await as.post('demo.design.lead', `/discussions/${design.id}/messages`, { body: 'Again', mentionUserIds: [member] });
      while ((await relay.runOnce()) > 0) {
        /* drain */
      }
      const mentions = (await as.get('demo.design', '/notifications?pageSize=100')).body.items.filter((n: { jobNumber: string; type: string }) => n.jobNumber === job.jobNumber && n.type === 'mention');
      expect(mentions).toHaveLength(1);
      // Users cannot read or mark other people's notifications.
      const other = await prisma.notification.findFirstOrThrow({ where: { userId: { not: member } } });
      await s.agent.post(`${API}/notifications/${other.id}/read`).set('X-CSRF-Token', s.csrf).expect(404);
    });

    it('sends due-soon and overdue task reminders once a day', async () => {
      const job = await as.createJob('VB', COMPLETE_VB_BRIEF);
      await as.completeCurrent(job.id);
      const wf = await as.workflow(job.id);
      const member = await ids('demo.design');
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await as.post('demo.design.lead', `/jobs/${job.id}/tasks`, { stageId: as.current(wf).id, title: 'Late task', assigneeIds: [member], dueDate: yesterday });
      const notifier = new Notifier(prisma, null);
      await notifier.taskReminders();
      await notifier.taskReminders();
      const overdue = await prisma.notification.count({ where: { userId: member, type: 'task.overdue', jobId: job.id } });
      expect(overdue).toBe(1);
      expect((await as.get('demo.design', '/tasks?mine=true&status=overdue')).body.items.some((t: TaskDto) => t.title === 'Late task' && t.overdue)).toBe(true);
    });
  });
});
