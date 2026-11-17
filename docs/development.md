# Development

## Versions (pinned)

| Tool | Version | Where pinned |
|---|---|---|
| Node.js | 26.13 LTS | `.nvmrc`, `package.json` engines, `Dockerfile` |
| npm | 11 (ships with Node 26) | — npm 10 crashes on this dependency tree |
| NestJS | 12.5 (ESM only) | `apps/api/package.json` |
| Prisma | 7.10.1 (driver adapter `@prisma/adapter-pg`) | `apps/api/package.json` |
| TypeScript | 6.0 | both apps |
| React / Vite / Mantine | 19.3 / 8.3 / 9.8 | `apps/web/package.json` |
| PostgreSQL | 17.12 | `deploy/docker-compose.yml` |
| Redis | 8.2.11 | `deploy/docker-compose.yml` |
| Caddy | 2.11.9 | `Dockerfile` |

npm 11 blocks dependency install scripts unless approved; the approved list is
`allowScripts` in the root `package.json` (argon2, prisma, @prisma/engines).

`overrides` in the root `package.json` pins `uuid` to 11.1.1 for ExcelJS
(advisory GHSA-w5hq-g745-h8pq); remove it once ExcelJS depends on a fixed
version itself. Run `npm audit` before each release.

## Layout

```
packages/shared   permission keys, Zod schemas, DTO types (built to dist/)
apps/api          NestJS API + worker + CLI (seed, create-admin)
apps/web          React app (Vite)
deploy            docker-compose.yml, Caddyfile, .env.example, scripts
```

## Running locally

Needs Node 26 and a PostgreSQL 16+ you can create databases on.

```bash
npm ci
npm run build:shared
cd apps/api
echo 'DATABASE_URL=postgresql://jobflow:jobflow_dev@localhost:5432/jobflow' > .env
echo 'COOKIE_SECURE=false' >> .env
npx prisma migrate deploy
npm run build && node dist/cli/seed.js --demo   # demo users, password Demo-Password-2026
npm run start:dev                                # API on :3000
# second terminal
npm run dev -w @jobflow/web                      # web on :5173, proxies /api
```

`COOKIE_SECURE=false` is for plain-HTTP development only.

## Tests

```bash
npm test -w @jobflow/shared
npm test -w @jobflow/api          # unit tests
npm run test:e2e -w @jobflow/api  # API tests against a real PostgreSQL
npm test -w @jobflow/web          # React tests (jsdom)
```

The e2e suite needs `ffmpeg` on the PATH (it generates an over-long voice
note) and creates and drops the database named in `E2E_DATABASE_URL`
(default `postgresql://jobflow:jobflow_dev@localhost:5432/jobflow_e2e`), so the
role needs `CREATEDB`.

## API documentation

`docs/api/openapi.json` is generated from the code (Zod schemas included):

```bash
cd apps/api && npm run build && node dist/cli/openapi.js ../../docs/api/openapi.json
```

Set `API_DOCS=true` to serve Swagger UI at `/api/v1/docs` (development only).

## Database changes

Edit `apps/api/prisma/schema.prisma`, then `npx prisma migrate dev --name <change>`
and commit the generated SQL. Never edit an applied migration or production
tables by hand. Production applies migrations with the `migrate` service on
every `docker compose up`.
