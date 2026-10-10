// PW-053 — a worker process to be killed (SIGKILL) at a chosen point of a Writer run. Synthetic data only;
// the MOCK writer (no provider). Prints one line per stage on stdout:
//   CLAIMING → (mode hang_in_call) IN_CALL and waits forever; (mode normal) DONE <outcome> when finished.
// usage: node --experimental-strip-types tests/faults/writer-child.ts <dbUrl> <paperId> <jobId> <mode> <leaseMs>
import pg from 'pg';
import { processDelivery } from '../../apps/worker/src/queue/index.ts';
import { createMockWriter, writerHandlers, type Writer } from '../../apps/worker/src/writer/index.ts';

const [dbUrl, paperId, jobId, mode, leaseMs] = process.argv.slice(2);
if (!dbUrl || !paperId || !jobId || !mode || !leaseMs) throw new Error('usage: writer-child <dbUrl> <paperId> <jobId> <mode> <leaseMs>');
const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
const mock = createMockWriter();
const writer: Writer = mode === 'hang_in_call'
  ? { ...mock, async write() { process.stdout.write('IN_CALL\n'); return new Promise(() => {}); } }
  : mock;
process.stdout.write('CLAIMING\n');
const out = await processDelivery(pool, { job_id: jobId, paper_id: paperId, intent: 'draft_paragraph' }, { workerId: `child-${process.pid}`, leaseMs: Number(leaseMs), handlers: writerHandlers(pool, writer) });
process.stdout.write(`DONE ${out.outcome}\n`);
await pool.end();
