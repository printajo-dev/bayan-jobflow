import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { fileTypeFromFile } from 'file-type';
import type { JobFileDto } from '@jobflow/shared';
import { PrismaService } from '../core/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { config } from '../config/config.js';
import type { ActionMeta } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { JobsService } from '../jobs/jobs.service.js';

/** Binary types recognised from their content ("magic bytes"). */
const BINARY_TYPES = new Map<string, string>([
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
/** Original extensions accepted when the content is one of the binary types (e.g. Illustrator files are PDF inside). */
const COMPATIBLE_EXTENSIONS: Record<string, string[]> = { pdf: ['pdf', 'ai'], jpg: ['jpg', 'jpeg'], tif: ['tif', 'tiff'] };
/** Plain-text formats with no magic bytes; accepted only if the content is valid UTF-8 text. */
const TEXT_TYPES = new Map<string, string>([
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['dxf', 'image/vnd.dxf'],
]);
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface StoredUpload {
  path: string;
  originalname: string;
  size: number;
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

  tempDir(): string {
    return join(this.root, 'tmp');
  }

  /** Validates the content type and moves the temporary upload into storage. */
  async addJobFile(jobId: string, upload: StoredUpload | undefined, purpose: 'BRIEF', p: Principal, meta: ActionMeta): Promise<JobFileDto> {
    try {
      if (!upload) throw new BadRequestException('Choose a file to upload');
      const facts = await this.jobs.authorize(jobId, p, 'uploadFile');
      const originalName = sanitizeName(upload.originalname);
      const { ext, mime } = await this.detect(upload.path, originalName);
      const sha256 = await sha256Of(upload.path);
      const id = randomUUID();
      const storageKey = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
      const target = this.pathFor(storageKey);
      await mkdir(dirname(target), { recursive: true, mode: 0o750 });
      await rename(upload.path, target);

      return await this.prisma.$transaction(async (tx) => {
        const file = await tx.file.create({
          data: { storageKey, originalName, mimeType: mime, extension: ext, size: BigInt(upload.size), sha256, uploadedById: meta.actorId },
          include: { uploadedBy: { select: { fullName: true } } },
        });
        const link = await tx.jobFile.create({ data: { jobId, fileId: file.id, purpose, addedById: meta.actorId } });
        await this.audit.record(tx, meta, {
          action: 'job.file_added',
          entityType: 'job',
          entityId: jobId,
          summary: `File "${originalName}" (${mime}, ${upload.size} bytes) attached to ${facts.jobNumber}`,
          after: { fileId: file.id, sha256, purpose },
        });
        return {
          id: file.id,
          originalName,
          mimeType: mime,
          size: upload.size,
          sha256,
          purpose,
          uploadedBy: file.uploadedBy?.fullName ?? null,
          createdAt: link.createdAt.toISOString(),
        };
      });
    } finally {
      if (upload) await rm(upload.path, { force: true });
    }
  }

  /** Removes the file from the job (the stored file and its history are kept). */
  async removeJobFile(jobId: string, fileId: string, p: Principal, meta: ActionMeta): Promise<void> {
    const facts = await this.jobs.authorize(jobId, p, 'removeFile');
    await this.prisma.$transaction(async (tx) => {
      const link = await tx.jobFile.findUnique({ where: { jobId_fileId: { jobId, fileId } }, include: { file: true } });
      if (!link || link.removedAt) throw new NotFoundException('File not found');
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

  /**
   * Returns the file if the user may see a job it is attached to. Unknown ids
   * and files the user may not see both give 404, so ids cannot be probed.
   */
  async openForDownload(fileId: string, p: Principal, meta: ActionMeta, inline: boolean) {
    if (!p.has('file.download')) throw new NotFoundException('File not found');
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: { jobs: { where: { removedAt: null }, select: { jobId: true } } },
    });
    if (!file || file.deletedAt) throw new NotFoundException('File not found');
    let allowed = false;
    for (const { jobId } of file.jobs) {
      try {
        await this.jobs.authorize(jobId, p);
        allowed = true;
        break;
      } catch {
        /* not visible through this job */
      }
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
    if (detected && BINARY_TYPES.has(detected.ext)) {
      const okExt = COMPATIBLE_EXTENSIONS[detected.ext] ?? [detected.ext];
      if (claimed && !okExt.includes(claimed)) {
        throw new BadRequestException(`The file content is ${detected.ext.toUpperCase()}, which does not match the .${claimed} name`);
      }
      return { ext: detected.ext, mime: BINARY_TYPES.get(detected.ext)! };
    }
    if (!detected && TEXT_TYPES.has(claimed) && (await looksLikeText(path))) {
      return { ext: claimed, mime: TEXT_TYPES.get(claimed)! };
    }
    throw new BadRequestException(
      'This file type is not allowed. Use PDF, AI, images (PNG, JPG, WEBP, TIFF, HEIC), PSD, EPS, DXF, ZIP, Word/Excel/PowerPoint, TXT or CSV.',
    );
  }

  private pathFor(storageKey: string): string {
    const full = resolve(this.root, storageKey);
    if (!full.startsWith(this.root + sep)) throw new NotFoundException('File not found');
    return full;
  }
}
