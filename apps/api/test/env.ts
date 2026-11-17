/**
 * The e2e suite needs a PostgreSQL role that may create databases. Locally
 * this is the dev `jobflow` role; CI sets E2E_DATABASE_URL.
 */
export const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://jobflow:jobflow_dev@localhost:5432/jobflow_e2e';
