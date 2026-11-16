import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  type ChangePasswordInput,
  type CurrentUserDto,
  type LoginInput,
} from '@jobflow/shared';
import { AllowPasswordChangePending, CurrentPrincipal, Public } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { AuthService, type LoginContext } from './auth.service.js';
import { type IssuedSession, sessionCookieName, sessionCookieOptions } from './session.service.js';
import { config } from '../config/config.js';

function loginContext(req: Request): LoginContext {
  return {
    requestId: req.requestId,
    ip: req.ip ?? null,
    actorId: req.principal?.userId ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: config().LOGIN_RATE_PER_MINUTE } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginSchema }) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CurrentUserDto> {
    const session = await this.auth.login(body, loginContext(req));
    this.setCookie(res, session);
    return this.auth.currentUser(session.userId, session.csrfToken);
  }

  @AllowPasswordChangePending()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.sessionId!, loginContext(req));
    res.clearCookie(sessionCookieName(), sessionCookieOptions());
  }

  @AllowPasswordChangePending()
  @Get('me')
  me(@CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<CurrentUserDto> {
    return this.auth.currentUser(principal.userId, req.csrfToken!);
  }

  @AllowPasswordChangePending()
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Body({ schema: changePasswordSchema }) body: ChangePasswordInput,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CurrentUserDto> {
    const session = await this.auth.changePassword(principal.userId, body, loginContext(req));
    this.setCookie(res, session);
    return this.auth.currentUser(principal.userId, session.csrfToken);
  }

  private setCookie(res: Response, session: IssuedSession): void {
    res.cookie(sessionCookieName(), session.token, sessionCookieOptions(session.expiresAt));
  }
}
