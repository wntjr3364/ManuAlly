// AI requests and their progress stream (PW-020, spec 04/07).
// - POST …/ai-requests: the owner asks about or asks to correct a frozen selection. Returns the job;
//   the worker answers later. 201 for a new request, 200 for a resend with the same key.
// - GET …/jobs/:jobId/events: Server-Sent Events. Each stored job event is sent once, in order, with
//   its sequence number as the event id, so a reconnect (Last-Event-ID, or ?after=) continues where it
//   stopped. When the job ends an `end` event carries its status. Closing the connection only stops
//   this stream; it never cancels the job (cancel is an explicit owner action).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { TxPool } from '@pw/domain/revisions/index.ts';
import { requestSelectionAi } from '@pw/domain/ai/index.ts';
import { TERMINAL, getJob, listJobEvents } from '@pw/domain/jobs/index.ts';
import { DomainError } from '@pw/domain/shared/db.ts';
import { sendDomainError } from '../auth/plugin.ts';

const KEEPALIVE_MS = 15_000;

export function registerAiRoutes(app: FastifyInstance, pool: TxPool, opts: { pollMs?: number } = {}): void {
  const scoped = { config: { paperScoped: true } };
  const pollMs = opts.pollMs ?? 250;

  app.post('/api/papers/:paperId/documents/:documentId/ai-requests', scoped, async (req, reply: FastifyReply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const out = await requestSelectionAi(pool, {
        paperId: req.paper!.id, ownerId: req.session!.ownerId, documentId: (req.params as { documentId: string }).documentId,
        baseRevisionId: b.base_revision_id, selection: b.selection, intent: b.intent, instruction: b.instruction, idempotencyKey: b.idempotency_key,
      });
      return reply.code(out.created ? 201 : 200).send(out);
    } catch (e) {
      if (e instanceof DomainError) return sendDomainError(e, reply);
      throw e;
    }
  });

  // open streams are ended when the server closes, so shutdown never waits for a browser
  const open = new Set<ServerResponse>();
  let closing = false;
  app.addHook('onClose', async () => {
    closing = true;
    for (const res of open) res.end();
  });

  app.get('/api/papers/:paperId/jobs/:jobId/events', scoped, async (req, reply) => {
    const paperId = req.paper!.id;
    const jobId = (req.params as { jobId: string }).jobId;
    if (!(await getJob(pool, paperId, jobId))) return reply.code(404).send({ error: 'not_found' });
    const raw = req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? '0';
    let after = /^\d{1,9}$/.test(String(raw)) ? Number(raw) : 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    open.add(res);
    let gone = false;
    res.on('close', () => { gone = true; }); // the browser left: stop streaming, nothing else
    const send = (event: string, data: unknown, id?: number) => res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const flush = async () => {
      for (const e of await listJobEvents(pool, paperId, jobId, after)) {
        send(e.kind, e.data, e.seq);
        after = e.seq;
      }
    };
    let lastStatus = '';
    let lastWrite = Date.now();
    try {
      while (!gone && !closing) {
        await flush();
        const job = (await getJob(pool, paperId, jobId))!;
        if (job.status !== lastStatus) {
          lastStatus = job.status;
          send('job', { status: job.status });
        }
        if (TERMINAL.includes(job.status) || job.status.startsWith('WAITING_')) {
          // a run's last events commit together with its final status: read once more, then end
          await flush();
          send('end', { status: job.status, last_error: job.last_error });
          break;
        }
        if (Date.now() - lastWrite > KEEPALIVE_MS) { res.write(': keep-alive\n\n'); lastWrite = Date.now(); }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (e) {
      req.log.error({ err: e }, 'job event stream failed'); // the browser reconnects with Last-Event-ID
    } finally {
      open.delete(res);
      if (!res.writableEnded) res.end();
    }
  });
}
