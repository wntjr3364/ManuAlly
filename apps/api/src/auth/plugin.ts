// Authentication, Origin/CSRF checks and the login rate limit.
// Access is decided by the MATCHED route (req.routeOptions), never by the raw URL, and routes are
// private unless they declare config.public — so encoded paths or new routes cannot slip past.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, inTransaction, type TxPool } from '@pw/domain/shared/db.ts';
import { authenticate, createOwner } from './owners.ts';
import { createSession, csrfMatches, lookupSession, revokeSession, type SessionInfo } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface AuthOptions {
  db: TxPool;
  allowedOrigins: string[];
  secureCookies: boolean;
  sessionTtlMs: number;
  loginRateLimit: { max: number; windowMs: number };
  allowRemoteSetup: boolean;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SETUP_LOCK = 728_012;

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return undefined; // malformed cookie = no session
    }
  }
  return undefined;
}

export function registerAuth(app: FastifyInstance, o: AuthOptions): void {
  app.decorateRequest('session', null);
  // With Secure cookies the __Host- prefix also pins Path=/ and forbids a Domain attribute.
  const COOKIE = o.secureCookies ? '__Host-pw_session' : 'pw_session';
  const cookie = (value: string, maxAgeSec: number) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${o.secureCookies ? '; Secure' : ''}`;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Every state-changing request (including login/setup and unmatched URLs) needs an allowed Origin.
    if (UNSAFE.has(req.method) && !o.allowedOrigins.includes(String(req.headers.origin ?? ''))) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    if (req.routeOptions.config?.public === true) return;
    const s = await lookupSession(o.db, readCookie(req, COOKIE));
    if (!s) return reply.code(401).send({ error: 'not_authenticated' });
    if (UNSAFE.has(req.method) && !csrfMatches(req.headers['x-pw-csrf'], s.csrf)) return reply.code(403).send({ error: 'csrf' });
    req.session = s;
  });

  // In-memory, per remote address. A slot is reserved BEFORE the password is checked, so parallel
  // requests cannot all slip through; a successful login gives its slot back.
  // Behind a reverse proxy configure trustProxy explicitly first.
  const attempts = new Map<string, number[]>();
  const reserve = (ip: string): number | null => {
    const now = Date.now();
    if (attempts.size > 10_000) for (const [k, v] of attempts) if (!v.some((t) => now - t < o.loginRateLimit.windowMs)) attempts.delete(k);
    const recent = (attempts.get(ip) ?? []).filter((t) => now - t < o.loginRateLimit.windowMs);
    if (recent.length >= o.loginRateLimit.max) {
      attempts.set(ip, recent);
      return null;
    }
    recent.push(now);
    attempts.set(ip, recent);
    return now;
  };
  const release = (ip: string, slot: number) => {
    const list = attempts.get(ip);
    if (!list) return;
    const i = list.indexOf(slot);
    if (i >= 0) list.splice(i, 1);
  };

  const pub = { config: { public: true } };

  app.post('/api/setup', pub, async (req, reply) => {
    if (!o.allowRemoteSetup && !LOOPBACK.has(req.ip)) return reply.code(403).send({ error: 'setup_only_from_localhost' });
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    // One transaction-scoped lock: concurrent setups are serialised, so only the first can see zero owners.
    const owner = await inTransaction(o.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
      const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM owners');
      if (rows[0]!.n > 0) return null;
      return createOwner(tx, body);
    });
    if (!owner) return reply.code(409).send({ error: 'already_set_up' });
    return reply.code(201).send({ owner });
  });

  app.post('/api/auth/login', pub, async (req, reply) => {
    const slot = reserve(req.ip);
    if (slot === null) return reply.code(429).send({ error: 'too_many_attempts' });
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const owner = await authenticate(o.db, body.username, body.password);
    if (!owner) return reply.code(401).send({ error: 'invalid_credentials' });
    release(req.ip, slot);
    // a session presented with the login request is replaced, not kept alive alongside
    const previous = await lookupSession(o.db, readCookie(req, COOKIE));
    if (previous) await revokeSession(o.db, previous.tokenHash);
    const { token, csrfToken } = await createSession(o.db, owner.id, o.sessionTtlMs);
    reply.header('set-cookie', cookie(token, Math.floor(o.sessionTtlMs / 1000)));
    return { owner, csrfToken };
  });

  // Same-origin only (no CORS): a reloaded page gets the session's CSRF token again.
  app.get('/api/auth/session', async (req) => {
    const s = req.session!;
    return { owner: { id: s.ownerId, username: s.username }, csrfToken: s.csrf };
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
    return reply.code(status).send({ ...err.details, error: err.code.toLowerCase(), message: err.message, field: err.field ?? null });
  }
  throw err;
}
