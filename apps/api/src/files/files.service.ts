import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { fileTypeFromFile } from 'file-type';
import { parseFile } from 'music-metadata';
import { MAX_VOICE_SECONDS, type JobFileDto } from '@jobflow/shared';
import { PrismaService, type Tx } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { config } from '../config/config.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';

/** Binary document types recognised from their content ("magic bytes"). */
const DOCUMENT_TYPES = new Map<string, string>([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['tif', 'image/tiff'],
  ['heic', 'image/heic'],
  ['psd', 'image/vnd.adobe.photoshop'],
  ['eps', 'application/postscript'],
  ['zip', 'application/zip'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);
/** Audio types accepted for voice notes (browsers record WebM/Opus; Safari records MP4/AAC). */
const VOICE_TYPES = new Map<string, string>([
  ['webm', 'audio/webm'],
  ['ogg', 'audio/ogg'],
  ['opus', 'audio/ogg'],
  ['m4a', 'audio/mp4'],
  ['mp4', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
]);
const COMPATIBLE_EXTENSIONS: Record<string, string[]> = {
  pdf: ['pdf', 'ai'],
  jpg: ['jpg', 'jpeg'],
  tif: ['tif', 'tiff'],
  webm: ['webm', 'weba'],
  ogg: ['ogg', 'oga', 'opus'],
  opus: ['ogg', 'oga', 'opus'],
  m4a: ['m4a', 'mp4', 'aac'],
  mp4: ['m4a', 'mp4', 'aac'],
};
const TEXT_TYPES = new Map<string, string>([
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['dxf', 'image/vnd.dxf'],
]);
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', ...VOICE_TYPES.values()]);
/** Generous upper bound for a voice note: 256 kbit/s for the maximum duration. */
const MAX_VOICE_BYTES = MAX_VOICE_SECONDS * 32 * 1024;

export type FilePurpose = 'BRIEF' | 'ARTWORK' | 'APPROVAL_EVIDENCE' | 'ROUND' | 'DISCUSSION' | 'VOICE' | 'CORRECTION' | 'OPERATIONS' | 'AUTHORITY' | 'QC' | 'DELIVERY';

export interface StoredUpload {
  path: string;
  originalname: string;
  size: number;
}

export interface StoredFile {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  durationSec: number | null;
}

export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (clean || 'file').slice(0, 200);
}

async function looksLikeText(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const sample = buf.subarray(0, bytesRead);
    if (sample.includes(0)) return false;
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, bytesRead - 4)));
    return true;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Stores uploads on the server's file system under random keys and keeps the
 * metadata and access links in PostgreSQL. Files are never served from a
 * public folder: downloads go through permission checks and are logged.
 */
@Injectable()
export class FilesService {
  private readonly root = resolve(config().FILES_ROOT);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Validates and stores a temporary upload, links it to the job with the
   * given purpose and returns the stored file. The temporary file is always
   * removed. Callers check permissions first.
   */
  async store(jobId: string, upload: StoredUpload | undefined, purpose: FilePurpose, meta: ActionMeta, opts: { clientDurationSec?: number } = {}): Promise<StoredFile> {
    try {
      if (!upload) throw new BadRequestException('Choose a file to upload');
      const originalName = sanitizeName(upload.originalname);
      const voice = purpose === 'VOICE';
      const { ext, mime } = voice ? await this.detectVoice(upload.path, originalName) : await this.detect(upload.path, originalName);
      let durationSec: number | null = null;
      if (voice) durationSec = await this.voiceDuration(upload.path, upload.size, opts.clientDurationSec);
      const sha256 = await sha256Of(upload.path);
      const id = randomUUID();
      const storageKey = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
      const target = this.pathFor(storageKey);
      await mkdir(dirname(target), { recursive: true, mode: 0o750 });
      await rename(upload.path, target);
      const file = await this.prisma.file.create({
        data: { storageKey, originalName, mimeType: mime, extension: ext, size: BigInt(upload.size), sha256, durationSec, uploadedById: meta.actorId },
      });
      await this.prisma.jobFile.create({ data: { jobId, fileId: file.id, purpose, addedById: meta.actorId } });
      return { id: file.id, originalName, mimeType: mime, size: upload.size, sha256, durationSec };
    } finally {
      if (upload) await rm(upload.path, { force: true });
    }
  }

  /** Removes a temporary upload that will not be stored (e.g. permission denied). */
  async discard(upload: StoredUpload | undefined): Promise<void> {
    if (upload) await rm(upload.path, { force: true });
  }

  /** Brief attachments (Files tab). */
  async addJobFile(jobId: string, upload: StoredUpload | undefined, p: Principal, meta: ActionMeta): Promise<JobFileDto> {
    let facts;
    try {
      facts = await this.jobs.authorize(jobId, p, 'uploadFile');
    } catch (e) {
      if (upload) await rm(upload.path, { force: true });
      throw e;
    }
    const f = await this.store(jobId, upload, 'BRIEF', meta);
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, meta, {
        action: 'job.file_added',
        entityType: 'job',
        entityId: jobId,
        summary: `File "${f.originalName}" (${f.mimeType}, ${f.size} bytes) attached to ${facts.jobNumber}`,
        after: { fileId: f.id, sha256: f.sha256, purpose: 'BRIEF' },
      }),
    );
    const uploader = meta.actorId ? await this.prisma.user.findUnique({ where: { id: meta.actorId }, select: { fullName: true } }) : null;
    return { ...f, purpose: 'BRIEF', uploadedBy: uploader?.fullName ?? null, createdAt: new Date().toISOString() };
  }

  async removeJobFile(jobId: string, fileId: string, p: Principal, meta: ActionMeta): Promise<void> {
    const facts = await this.jobs.authorize(jobId, p, 'removeFile');
    await this.prisma.$transaction(async (tx) => {
      const link = await tx.jobFile.findUnique({ where: { jobId_fileId: { jobId, fileId } }, include: { file: true } });
      if (!link || link.removedAt || link.purpose !== 'BRIEF') throw new NotFoundException('File not found');
      await tx.jobFile.update({ where: { id: link.id }, data: { removedAt: new Date(), removedById: meta.actorId } });
      await this.audit.record(tx, meta, {
        action: 'job.file_removed',
        entityType: 'job',
        entityId: jobId,
        summary: `File "${link.file.originalName}" removed from ${facts.jobNumber}`,
        before: { fileId, sha256: link.file.sha256 },
      });
    });
  }

  /** Verifies that files referenced in a request were uploaded by this user to this job for this purpose and are not used yet. */
  async assertOwnUnusedUploads(tx: Tx, jobId: string, fileIds: string[], purposes: FilePurpose[], userId: string | null): Promise<void> {
    if (!fileIds.length) return;
    const links = await tx.jobFile.findMany({
      where: { jobId, fileId: { in: fileIds }, purpose: { in: purposes }, addedById: userId, removedAt: null },
      include: { file: { include: { messages: true, corrections: true, rounds: true } } },
    });
    const ok = links.filter((l) => l.file.messages.length === 0 && l.file.corrections.length === 0 && l.file.rounds.length === 0);
    if (ok.length !== new Set(fileIds).size) throw new BadRequestException('One or more attachments are invalid or already used');
  }

  /**
   * Returns the file if the user may see it. Access depends on why the file
   * is attached: discussion attachments need access to that channel, design
   * files need artwork access, everything else needs access to the job.
   * Unknown ids and forbidden files both give 404, so ids cannot be probed.
   */
  async openForDownload(fileId: string, p: Principal, meta: ActionMeta, inline: boolean, canViewChannel: (channelId: string) => Promise<boolean>) {
    if (!p.has('file.download')) throw new NotFoundException('File not found');
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: { jobs: { where: { removedAt: null } }, messages: { include: { message: { select: { channelId: true, deletedAt: true } } } } },
    });
    if (!file || file.deletedAt) throw new NotFoundException('File not found');
    let allowed = false;
    for (const link of file.jobs) {
      try {
        await this.jobs.authorize(link.jobId, p);
      } catch {
        continue;
      }
      if (link.purpose === 'DISCUSSION' || link.purpose === 'VOICE') {
        if (file.messages.length === 0) allowed = link.addedById === p.userId;
        else {
          for (const m of file.messages) if (!m.message.deletedAt && (await canViewChannel(m.message.channelId))) allowed = true;
        }
      } else if (link.purpose === 'ARTWORK' || link.purpose === 'ROUND' || link.purpose === 'APPROVAL_EVIDENCE') {
        allowed = p.has('artwork.view') || p.has('customer_approval.record');
      } else if (link.purpose === 'AUTHORITY') {
        allowed = p.has('authority.view');
      } else {
        allowed = true;
      }
      if (allowed) break;
    }
    if (!allowed) throw new NotFoundException('File not found');
    const path = this.pathFor(file.storageKey);
    const size = (await stat(path)).size;
    const asInline = inline && INLINE_TYPES.has(file.mimeType);
    await this.prisma.fileAccessLog.create({ data: { fileId, userId: meta.actorId, action: asInline ? 'preview' : 'download', ip: meta.ip } });
    return {
      stream: createReadStream(path),
      size,
      mimeType: file.mimeType,
      disposition: `${asInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    };
  }

  private async detect(path: string, originalName: string): Promise<{ ext: string; mime: string }> {
    const claimed = extname(originalName).slice(1).toLowerCase();
    const detected = await fileTypeFromFile(path);
    if (detected && DOCUMENT_TYPES.has(detected.ext)) {
      this.assertExtension(detected.ext, claimed);
      return { ext: detected.ext, mime: DOCUMENT_TYPES.get(detected.ext)! };
    }
    if (!detected && TEXT_TYPES.has(claimed) && (await looksLikeText(path))) {
      return { ext: claimed, mime: TEXT_TYPES.get(claimed)! };
    }
    throw new BadRequestException(
      'This file type is not allowed. Use PDF, AI, images (PNG, JPG, WEBP, TIFF, HEIC), PSD, EPS, DXF, ZIP, Word/Excel/PowerPoint, TXT or CSV.',
    );
  }

  private async detectVoice(path: string, originalName: string): Promise<{ ext: string; mime: string }> {
    const claimed = extname(originalName).slice(1).toLowerCase();
    const detected = await fileTypeFromFile(path);
    if (detected && VOICE_TYPES.has(detected.ext)) {
      this.assertExtension(detected.ext, claimed);
      return { ext: detected.ext, mime: VOICE_TYPES.get(detected.ext)! };
    }
    throw new BadRequestException('Voice notes must be WebM, Ogg/Opus, MP4/AAC or MP3 audio');
  }

  private assertExtension(detected: string, claimed: string): void {
    const ok = COMPATIBLE_EXTENSIONS[detected] ?? [detected];
    if (claimed && !ok.includes(claimed)) {
      throw new BadRequestException(`The file content is ${detected.toUpperCase()}, which does not match the .${claimed} name`);
    }
  }

  /**
   * Reads the duration from the audio container. Browser recordings (WebM)
   * often have no duration header; then the size limit and the duration the
   * recorder reported (capped) are used.
   */
  private async voiceDuration(path: string, size: number, clientDurationSec?: number): Promise<number> {
    if (size > MAX_VOICE_BYTES) throw new BadRequestException(`Voice notes can be at most ${MAX_VOICE_SECONDS / 60} minutes`);
    let seconds: number | undefined;
    try {
      seconds = (await parseFile(path, { duration: true, skipCovers: true })).format.duration;
    } catch {
      throw new BadRequestException('The voice recording could not be read');
    }
    const value = seconds && Number.isFinite(seconds) ? seconds : (clientDurationSec ?? 0);
    if (value > MAX_VOICE_SECONDS + 1) throw new BadRequestException(`Voice notes can be at most ${MAX_VOICE_SECONDS / 60} minutes`);
    return Math.max(0, Math.round(value));
  }

  pathFor(storageKey: string): string {
    const full = resolve(this.root, storageKey);
    if (!full.startsWith(this.root + sep)) throw new NotFoundException('File not found');
    return full;
  }

  tempDir(): string {
    return join(this.root, 'tmp');
  }
}
