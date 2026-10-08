import { buildServer } from './server.ts';

// Local development entry: loopback only (no remote exposure by default).
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer({ logger: true });
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PW_API_PORT ?? 8787) });
}
export { buildServer };
