# API

- `openapi.json` — OpenAPI 3 description of every endpoint under `/api/v1`,
  generated from the controllers and Zod schemas (see `docs/development.md`).
- Authentication: `POST /api/v1/auth/login` sets an HttpOnly session cookie and
  returns `csrfToken`. Send it as `X-CSRF-Token` on every POST/PUT/PATCH/DELETE.
- Errors always have the shape `{ statusCode, error, message, requestId }`.
  `message` is a string or a list of field messages. 404 is also returned for
  resources the user may not see, so ids cannot be probed.
- Lists are paginated with `page` and `pageSize` (max 100) and return
  `{ items, page, pageSize, total }`.
- Stage changes only happen through the workflow endpoints
  (`/jobs/{id}/stages/{stageId}/complete|hold|resume|return|reopen|complete-with-exception`);
  there is no endpoint that sets a status directly.
- Reports: `GET /reports` lists the reports the user may run;
  `GET /reports/{key}?from=YYYY-MM-DD&to=YYYY-MM-DD&group=month|week&format=json|csv|xlsx`
  runs one (`csv`/`xlsx` need `report.export`). `GET /dashboard` returns the
  caller's role-aware dashboard.
- System (administrators): `GET /system/status` (health, disk, outbox, backups;
  `outbox.manage`), `GET /system/outbox?status=DEAD|FAILED`,
  `POST /system/outbox/{id}/retry`, `GET /system/maintenance` (public) and
  `PUT /system/maintenance` (`settings.manage`). While maintenance mode is on,
  every authenticated route except `/auth/me` and `/auth/logout` answers `503`
  for users without `settings.manage`.
