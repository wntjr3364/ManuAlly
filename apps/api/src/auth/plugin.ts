// Authentication, Origin/CSRF checks and the login rate limit, applied to every /api route.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '@pw/domain/shared/db.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { authenticate, createOwner, ownerCount } from './owners.ts';
import { createSession, csrfMatches, lookupSession, revokeSession, rotateCsrf, type SessionInfo } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
}

export interface AuthOptions {
  db: Queryable;
  allowedOrigins: string[];
  secureCookies: boolean;
  sessionTtlMs: number;
  loginRateLimit: { max: number; windowMs: number };
  allowRemoteSetup: boolean;
}

const COOKIE = 'pw_session';
const PUBLIC = new Set(['/api/health', '/api/setup', '/api/auth/login']);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function registerAuth(app: FastifyInstance, o: AuthOptions): void {
  app.decorateRequest('session', null);
  const cookie = (value: string, maxAgeSec: number) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${o.secureCookies ? '; Secure' : ''}`;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    // Every state-changing request (including login/setup) must come from an allowed origin.
    if (UNSAFE.has(req.method) && !o.allowedOrigins.includes(String(req.headers.origin ?? ''))) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    if (PUBLIC.has(path)) return;
    const s = await lookupSession(o.db, readCookie(req, COOKIE));
    if (!s) return reply.code(401).send({ error: 'not_authenticated' });
    if (UNSAFE.has(req.method) && !csrfMatches(req.headers['x-pw-csrf'], s.csrfHash)) return reply.code(403).send({ error: 'csrf' });
    req.session = s;
  });

  // In-memory, per remote address. Behind a reverse proxy configure trustProxy explicitly first.
  const failures = new Map<string, number[]>();
  const limited = (ip: string) => {
    const now = Date.now();
    const recent = (failures.get(ip) ?? []).filter((t) => now - t < o.loginRateLimit.windowMs);
    failures.set(ip, recent);
    return recent.length >= o.loginRateLimit.max;
  };

  app.post('/api/setup', async (req, reply) => {
    if (!o.allowRemoteSetup && !LOOPBACK.has(req.ip)) return reply.code(403).send({ error: 'setup_only_from_localhost' });
    if ((await ownerCount(o.db)) > 0) return reply.code(409).send({ error: 'already_set_up' });
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const owner = await createOwner(o.db, body);
    return reply.code(201).send({ owner });
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'too_many_attempts' });
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const owner = await authenticate(o.db, body.username, body.password);
    if (!owner) {
      failures.get(req.ip)!.push(Date.now());
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const { token, csrfToken } = await createSession(o.db, owner.id, o.sessionTtlMs);
    reply.header('set-cookie', cookie(token, Math.floor(o.sessionTtlMs / 1000)));
    return { owner, csrfToken };
  });

  // Same-origin only (no CORS): lets a reloaded page obtain a fresh CSRF token.
  app.get('/api/auth/session', async (req) => {
    const s = req.session!;
    return { owner: { id: s.ownerId, username: s.username }, csrfToken: await rotateCsrf(o.db, s.tokenHash) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await revokeSession(o.db, req.session!.tokenHash);
    reply.header('set-cookie', cookie('', 0));
    return { ok: true };
  });
}

export function sendDomainError(err: unknown, reply: FastifyReply) {
  if (err instanceof DomainError) {
    const status = { NOT_FOUND: 404, CONFLICT: 409, INVALID: 422, FORBIDDEN: 403 }[err.code];
    return reply.code(status).send({ error: err.code.toLowerCase(), message: err.message, field: err.field ?? null });
  }
  throw err;
}
