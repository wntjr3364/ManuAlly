// The server's routes as (method, full path) pairs, read from Fastify's own route tree (PW-059 audit), so a
// sweep covers every route that exists — a new route is swept without anyone listing it.
import type { FastifyInstance } from 'fastify';

export interface Route { method: string; url: string }
export function listRoutes(app: FastifyInstance): Route[] {
  const out: Route[] = [];
  const stack: string[] = [];
  for (const raw of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const at = raw.indexOf('── ');
    if (at < 0) continue;
    const depth = Math.round(at / 4);
    const m = raw.slice(at + 3).match(/^(.*?)(?: \(([A-Z, ]+)\))?$/);
    if (!m) continue;
    const path = (depth > 0 ? stack[depth - 1] ?? '' : '') + m[1]!;
    stack[depth] = path;
    stack.length = depth + 1;
    for (const method of (m[2] ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (method !== 'HEAD') out.push({ method, url: path });
  }
  return out;
}
