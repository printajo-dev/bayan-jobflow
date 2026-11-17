import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, type RedisClientType } from 'redis';
import { parse as parseCookie } from 'cookie';
import { SessionService, sessionCookieName } from '../auth/session.service.js';
import { PrincipalLoader } from '../access/principal.loader.js';
import type { Principal } from '../access/principal.js';

export type ChannelAuthorizer = (p: Principal, channelId: string) => Promise<boolean>;

/**
 * Live updates over Socket.IO. PostgreSQL stays the source of truth: clients
 * re-fetch over REST on (re)connect, so a dropped socket or a Redis outage
 * only delays updates. Sockets authenticate with the same session cookie as
 * the REST API and may only join rooms they are allowed to read.
 *
 * Rooms: `user:<id>` (notifications, unread counts) and `channel:<id>`.
 * With REDIS_URL set, the Redis adapter lets the worker publish to the same
 * rooms through @socket.io/redis-emitter.
 */
@Injectable()
export class RealtimeService implements OnApplicationShutdown {
  private readonly logger = new Logger('Realtime');
  private io?: Server;
  private redis: RedisClientType[] = [];
  private authorizeChannel?: ChannelAuthorizer;

  constructor(
    private readonly sessions: SessionService,
    private readonly principals: PrincipalLoader,
  ) {}

  setChannelAuthorizer(fn: ChannelAuthorizer): void {
    this.authorizeChannel = fn;
  }

  async attach(server: HttpServer): Promise<void> {
    const io = new Server(server, {
      path: '/socket.io',
      serveClient: false,
      cors: undefined,
      transports: ['websocket', 'polling'],
      // Defence in depth next to the SameSite=Strict cookie: refuse handshakes
      // started by pages from another origin (cross-site WebSocket hijacking).
      allowRequest: (req, done) => {
        const origin = req.headers.origin;
        if (!origin) return done(null, true);
        let host: string | null = null;
        try {
          host = new URL(origin).host;
        } catch {
          host = null;
        }
        const expected = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
        done(null, !!host && host === expected);
      },
    });
    const url = process.env['REDIS_URL'];
    if (url) {
      try {
        const pub: RedisClientType = createClient({ url, socket: { reconnectStrategy: (n) => Math.min(n * 500, 10_000) } });
        const sub = pub.duplicate();
        pub.on('error', (e) => this.logger.warn(`Redis: ${e.message}`));
        sub.on('error', (e) => this.logger.warn(`Redis: ${e.message}`));
        await Promise.all([pub.connect(), sub.connect()]);
        io.adapter(createAdapter(pub, sub));
        this.redis = [pub, sub];
      } catch (e) {
        this.logger.warn(`Realtime runs without Redis: ${(e as Error).message}`);
      }
    }
    io.use(async (socket, next) => {
      try {
        const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
        const token = cookies[sessionCookieName()];
        const session = token ? await this.sessions.resolve(token) : null;
        const principal = session ? await this.principals.load(session.userId) : null;
        if (!principal) return next(new Error('unauthorized'));
        socket.data.principal = principal;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
    io.on('connection', (socket: Socket) => {
      const p = socket.data.principal as Principal;
      void socket.join(`user:${p.userId}`);
      socket.on('channel:join', async (channelId: unknown, ack?: (ok: boolean) => void) => {
        const ok = typeof channelId === 'string' && !!this.authorizeChannel && (await this.authorizeChannel(p, channelId).catch(() => false));
        if (ok) void socket.join(`channel:${channelId}`);
        ack?.(ok);
      });
      socket.on('channel:leave', (channelId: unknown) => {
        if (typeof channelId === 'string') void socket.leave(`channel:${channelId}`);
      });
    });
    this.io = io;
  }

  toChannel(channelId: string, event: string, payload: unknown): void {
    this.io?.to(`channel:${channelId}`).emit(event, payload);
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.io?.to(`user:${userId}`).emit(event, payload);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.io?.close().catch(() => undefined);
    for (const c of this.redis) await c.quit().catch(() => undefined);
  }
}
