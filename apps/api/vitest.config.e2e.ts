import { defineConfig } from 'vitest/config';
import { E2E_DATABASE_URL } from './test/env.js';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // One database is shared by all e2e files, so they run one after another.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: E2E_DATABASE_URL,
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      LOGIN_RATE_PER_MINUTE: '1000',
      LOG_LEVEL: 'error',
      FILES_ROOT: './.e2e-files',
      UPLOAD_MAX_MB: '2',
    },
  },
});
