// Verifies a source archive with nothing but the archive (PW-057):
//   node packages/exports/src/archive/cli.ts <archive.zip>
// Prints the verification as JSON (without the manifest) and exits 0 when the archive is complete and every
// check passed, 1 when it is incomplete or a check failed, 2 when it could not be read.
import fs from 'node:fs';
import { verifyArchive } from './index.ts';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node packages/exports/src/archive/cli.ts <archive.zip>\n');
  process.exit(2);
}
let bytes: Buffer;
try {
  bytes = fs.readFileSync(file);
} catch (e) {
  process.stderr.write(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
const v = verifyArchive(bytes);
const m = v.manifest;
process.stdout.write(`${JSON.stringify({ ok: v.ok, status: v.status, reproduced: v.reproduced, problems: v.problems, snapshot: m?.snapshot ?? null, purpose: m?.purpose ?? null, files: m?.files.length ?? 0, excluded: m?.excluded ?? [], missing: m?.missing ?? [] }, null, 2)}\n`);
process.exit(v.ok ? 0 : 1);
