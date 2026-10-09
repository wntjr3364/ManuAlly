import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  approveClaim, createClaim, createEvidence, createFactCandidates, getClaim, getEvidence, getFact, linkClaimEvidence,
  listClaims, listEvidence, listFacts, reviewEvidence, reviewFact,
} from '@pw/domain/evidence/index.ts';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../../auth/plugin.ts';

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

// Every write here records origin 'user' or 'import'; AI extraction (P03+) calls the domain with
// origin 'ai_extraction'. No route accepts a verifier, approver or review state from the client.
export function registerEvidenceRoutes(app: FastifyInstance, pool: TxPool): void {
  const scoped = { config: { paperScoped: true } };
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.code(status).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  const p = (params: unknown, k: string) => (params as Record<string, string>)[k]!;

  app.get('/api/papers/:paperId/evidence', scoped, async (req) => listEvidence(pool, req.paper!.id));
  app.post('/api/papers/:paperId/evidence', scoped, async (req, reply) =>
    run(reply, () => createEvidence(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body }), 201));
  app.get('/api/papers/:paperId/evidence/:evidenceId', scoped, async (req, reply) =>
    (await getEvidence(pool, req.paper!.id, p(req.params, 'evidenceId'))) ?? notFound(reply));
  app.post('/api/papers/:paperId/evidence/:evidenceId/verify', scoped, async (req, reply) =>
    run(reply, () => reviewEvidence(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, id: p(req.params, 'evidenceId'), body: req.body, to: 'VERIFIED' })));
  app.post('/api/papers/:paperId/evidence/:evidenceId/reject', scoped, async (req, reply) =>
    run(reply, () => reviewEvidence(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, id: p(req.params, 'evidenceId'), body: req.body, to: 'REJECTED' })));

  app.get('/api/papers/:paperId/facts', scoped, async (req) => listFacts(pool, req.paper!.id));
  app.post('/api/papers/:paperId/facts', scoped, async (req, reply) =>
    run(reply, async () => (await createFactCandidates(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, origin: 'user', facts: [req.body], single: true }))[0], 201));
  app.post('/api/papers/:paperId/facts/import', scoped, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(body).find((k) => k !== 'facts');
    if (extra) return reply.code(422).send({ error: 'invalid', message: `${extra} is not accepted here`, field: extra });
    return run(reply, () => createFactCandidates(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, origin: 'import', facts: body.facts }), 201);
  });
  app.get('/api/papers/:paperId/facts/:factId', scoped, async (req, reply) =>
    (await getFact(pool, req.paper!.id, p(req.params, 'factId'))) ?? notFound(reply));
  app.post('/api/papers/:paperId/facts/:factId/verify', scoped, async (req, reply) =>
    run(reply, () => reviewFact(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, id: p(req.params, 'factId'), body: req.body, to: 'VERIFIED' })));
  app.post('/api/papers/:paperId/facts/:factId/reject', scoped, async (req, reply) =>
    run(reply, () => reviewFact(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, id: p(req.params, 'factId'), body: req.body, to: 'REJECTED' })));

  app.get('/api/papers/:paperId/claims', scoped, async (req) => listClaims(pool, req.paper!.id));
  app.post('/api/papers/:paperId/claims', scoped, async (req, reply) =>
    run(reply, () => createClaim(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, body: req.body }), 201));
  app.get('/api/papers/:paperId/claims/:claimId', scoped, async (req, reply) =>
    (await getClaim(pool, req.paper!.id, p(req.params, 'claimId'))) ?? notFound(reply));
  app.post('/api/papers/:paperId/claims/:claimId/evidence-links', scoped, async (req, reply) =>
    run(reply, () => linkClaimEvidence(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, claimId: p(req.params, 'claimId'), body: req.body }), 201));
  app.post('/api/papers/:paperId/claims/:claimId/approve', scoped, async (req, reply) =>
    run(reply, () => approveClaim(pool, { paperId: req.paper!.id, ownerId: req.session!.ownerId, id: p(req.params, 'claimId'), body: req.body })));
}
