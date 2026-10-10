// The owner's budgets (PW-050): set a limit (app, paper with an optional per-run limit, or provider) and
// read a paper's budget status. Setting a budget is the owner's act; no run changes it.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { budgetStatus, setBudget } from '@pw/domain/budget/index.ts';
import { sendDomainError } from '../auth/plugin.ts';

export function registerBudgetRoutes(app: FastifyInstance, pool: TxPool): void {
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, code = 200) => {
    try {
      return reply.code(code).send(await fn());
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  };
  app.post('/api/budgets', async (req, reply) => run(reply, () => setBudget(pool, { ownerId: req.session!.ownerId, body: req.body }), 201));
  app.get('/api/papers/:paperId/budget', { config: { paperScoped: true } }, async (req, reply) => run(reply, () => budgetStatus(pool, req.session!.ownerId, req.paper!.id)));
}
