import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  /** Send cookies with the Secure flag. Must be true behind Caddy (HTTPS). */
  COOKIE_SECURE: bool.default(true),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(12 * 60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(7 * 24),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Requests per minute per IP on the login endpoint. */
  LOGIN_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /** Trust X-Forwarded-For from the reverse proxy (Caddy) for client IPs. */
  TRUST_PROXY: bool.default(true),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(1000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  /** Root folder for uploaded files (bind-mounted from /srv/company-data/files). */
  FILES_ROOT: z.string().min(1).default('./data/files'),
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(4096).default(200),
  /** Serve Swagger UI at /api/v1/docs. Off in production unless an admin enables it. */
  API_DOCS: bool.default(false),
  /** Written by deploy/scripts/backup.sh; shown on the System status page. */
  BACKUP_STATUS_FILE: z.string().default('/data/backups/status.json'),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Tests change env between files; this clears the cached copy. */
export function resetConfigCache(): void {
  cached = undefined;
}
