// PW-060 backup command line. Connections come from environment variable names, never from arguments.
//   backup  --out <new folder>            database PW_DATABASE_URL, originals PW_ASSET_DIR (or the default store)
//   verify  <set folder>
//   restore <set folder> --target-env <NAME> --asset-dir <folder>
//                                         restores into the empty database named by $NAME and migrates forward
// Prints a JSON report. Exit 0: complete / verified / restored; 1: failed (the report says why); 2: usage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAssetDir } from '../../packages/domain/src/asset-policy/store.ts';
import { createBackup, restoreBackup, verifyBackup } from './backup.ts';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const usage = (msg: string) => { process.stderr.write(`${msg}\nusage: backup --out DIR | verify DIR | restore DIR --target-env NAME --asset-dir DIR\n`); return 2; };
const print = (x: unknown) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'backup') {
    const out = arg(rest, '--out');
    const url = env.PW_DATABASE_URL;
    if (!out || !url) return usage('backup needs --out and PW_DATABASE_URL');
    const r = await createBackup({ databaseUrl: url, assetDir: defaultAssetDir(env as NodeJS.ProcessEnv), outDir: path.resolve(out) });
    print({ status: r.status, dir: r.dir, tables: Object.keys(r.manifest.tables).length, originals: r.manifest.blobs.length, warnings: r.manifest.warnings, problems: r.manifest.problems });
    return r.status === 'complete' ? 0 : 1;
  }
  if (cmd === 'verify') {
    const dir = rest[0];
    if (!dir) return usage('verify needs the set folder');
    const r = await verifyBackup(path.resolve(dir), { migrationsDir: MIGRATIONS });
    print({ ok: r.ok, problems: r.problems, created_at: r.manifest?.created_at ?? null, warnings: r.manifest?.warnings ?? [] });
    return r.ok ? 0 : 1;
  }
  if (cmd === 'restore') {
    const dir = rest[0];
    const name = arg(rest, '--target-env');
    const assetDir = arg(rest, '--asset-dir');
    if (!dir || !name || !assetDir) return usage('restore needs the set folder, --target-env and --asset-dir');
    const url = env[name];
    if (!url) return usage(`${name} is not set`);
    const r = await restoreBackup({ dir: path.resolve(dir), targetUrl: url, assetDir: path.resolve(assetDir), migrationsDir: MIGRATIONS });
    print(r);
    return r.status === 'restored' ? 0 : 1;
  }
  return usage(`unknown command ${cmd ?? ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; });
}
