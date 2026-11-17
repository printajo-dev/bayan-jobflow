import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const cfg = new DocumentBuilder()
    .setTitle('Bayan JobFlow API')
    .setDescription(
      'Internal LAN API. Authenticate with POST /api/v1/auth/login (session cookie). ' +
        'Send the csrfToken from the login or /auth/me response in the X-CSRF-Token header on every POST, PUT, PATCH and DELETE.',
    )
    .setVersion('1')
    .addCookieAuth('__Host-jf_session')
    .build();
  return SwaggerModule.createDocument(app, cfg);
}
