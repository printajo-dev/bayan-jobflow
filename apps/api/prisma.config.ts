import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` does not connect, so a placeholder is fine at build time.
    url: process.env['DATABASE_URL'] ?? 'postgresql://build:build@localhost:5432/build',
  },
});
