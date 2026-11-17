import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { config } from '../config/config.js';

const tmpDir = () => join(resolve(config().FILES_ROOT), 'tmp');

/** Single-file upload ("file" field) streamed to a temporary folder, size-limited before it reaches the handler. */
export function uploadInterceptor(maxMb = config().UPLOAD_MAX_MB) {
  return FileInterceptor('file', {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        const dir = tmpDir();
        mkdirSync(dir, { recursive: true, mode: 0o750 });
        cb(null, dir);
      },
      filename: (_req, _file, cb) => cb(null, randomUUID()),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 10 },
  });
}
