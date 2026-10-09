// Content-addressed store for immutable originals (PW-034): <dir>/sha256/<2 hex>/<sha256>, written
// once (temporary file, fsync, read-only, rename) and verified against its name whenever it is read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export class IntegrityError extends Error {}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const blobPath = (dir: string, hash: string) => path.join(dir, 'sha256', hash.slice(0, 2), hash);

export async function putBlob(dir: string, bytes: Buffer): Promise<string> {
  const hash = sha256(bytes);
  const target = blobPath(dir, hash);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    if (sha256(await fs.readFile(target)) === hash) return hash; // already stored
    await fs.chmod(target, 0o600); // a damaged copy is replaced by the verified bytes
    await fs.unlink(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const tmp = path.join(path.dirname(target), `.tmp-${randomBytes(8).toString('hex')}`);
  const fh = await fs.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.chmod(tmp, 0o444);
  await fs.rename(tmp, target);
  return hash;
}

export async function readVerified(dir: string, hash: string): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new IntegrityError('bad hash');
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(blobPath(dir, hash));
  } catch {
    throw new IntegrityError('the stored original is missing');
  }
  if (sha256(bytes) !== hash) throw new IntegrityError('the stored original does not match its hash');
  return bytes;
}
