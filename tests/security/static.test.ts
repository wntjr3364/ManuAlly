// PW-059 security audit — static checks over the source tree. Each list below is the reviewed set of places
// that may do the risky thing, with the reason; a new place fails here until it is reviewed and added
// (spec 09 "Credential", "파일과 URL", "공급망과 운영").
// TST-059A: no secret in git; outbound network only from the reviewed modules; a child process never inherits
//   the server's environment; no code reads the user's AI CLI credentials; the browser keeps no token.
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
// every shipped source file, whatever its kind (review m2: .js/.mjs/.cjs and infra/ and scripts/ too)
const source = tracked.filter((f) => /^(apps|packages|infra|scripts)\/.*\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\/(test|tests)\//.test(f) && !/\.(test|int\.test|e2e)\.[cm]?[jt]sx?$/.test(f));
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
// the code without comments and type-only imports (a comment or a type opens nothing)
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1').replace(/^\s*import type [^;]*;/gm, '');
const matching = (re: RegExp) => source.filter((f) => re.test(code(f))).sort();
// a module named in any form: import (either quote), export from, dynamic import(), require(), createRequire()(…)
const MODULE = (names: string) => new RegExp(`['"\`](node:)?(${names})['"\`]`);
// fetch called or taken as a value (not a property like cfg.fetch, a route path or a method of another object)
const FETCH_USE = /(?<![\w.$])fetch\s*\(|\b(globalThis|window|self|global)\s*\.\s*fetch\b|(?<![\w.$'"`/])fetch(?![\w$?:'"`/(<])/;

describe('TST-059A: secrets', () => {
  const SECRET = /sk-ant-[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}/;
  // synthetic look-alikes used to test the redaction (PW-052; one is AWS's published documentation example key)
  const SYNTHETIC: Record<string, string> = { 'tests/tasks/PW-052/classify.test.ts': 'redaction fixtures (synthetic, never valid)' };
  test('no tracked file holds a secret-shaped string, except the reviewed synthetic fixtures', () => {
    const hits = tracked.filter((f) => !/\.(png|jpg|pdf|docx|zip|woff2?|ico)$/i.test(f) && fs.existsSync(path.join(root, f)) && SECRET.test(read(f)));
    expect(hits.filter((f) => !SYNTHETIC[f])).toEqual([]);
  });
  test('no .env file or key file is tracked', () => {
    // .env.example: the documented template (no values beyond the mock provider and socket paths; the secret scan above covers it)
    expect(tracked.filter((f) => f !== '.env.example' && /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519)$/.test(f))).toEqual([]);
  });
});

describe('TST-059A: egress — outbound network only from reviewed modules', () => {
  const NET: Record<string, string> = {
    'apps/api/src/assets/fetch.ts': 'open-access PDF fetch: scheme/host/port allowlist, DNS answer re-checked against internal ranges, no redirects (PW-034)',
    'apps/worker/src/provider-runs/tool-socket.ts': 'local Unix socket between the sandboxed provider and the tool gateway (PW-027/RFC-010); no network',
    'apps/worker/src/provider-runs/mcp-bridge.mjs': 'inside the sandbox: stdio ↔ the gateway\'s Unix socket (RFC-010); no network',
    'infra/sandbox/egress-proxy.ts': 'the sandbox\'s only way out: CONNECT to the allowlisted provider hosts on 443 (RFC-010)',
    'infra/sandbox/forwarder.mjs': 'inside the sandbox: forwards the CLI\'s proxy port to the egress proxy socket (RFC-010)',
    'infra/sandbox/probe.mjs': 'sandbox self-test: shows that network, sockets and files outside are unreachable (PW-026)',
    'infra/sandbox/sandbox.ts': 'starts bubblewrap with the network namespace removed; Unix sockets only (PW-026)',
    'packages/domain/src/asset-policy/index.ts': 'net.isIP for address classification only; no connection',
  };
  const FETCH: Record<string, string> = {
    'apps/web/src/app/api.ts': 'browser → this app\'s own API (same origin)',
    'apps/web/src/features/pdf/SourceDocsTab.tsx': 'browser → this app\'s own API (same origin)',
    'packages/search/src/zotero/index.ts': 'Zotero Web API with the owner\'s key, fixed host (PW-033)',
    'packages/search/src/bibliographic/http.ts': 'Crossref/PubMed metadata search, fixed hosts, no paper text sent (PW-031)',
    'apps/api/src/assets/fetch.ts': 'the reviewed PDF fetcher (node https; "fetch" appears in its user-agent text)',
  };
  test('node network modules are named only where reviewed', () => {
    expect(matching(MODULE('http|https|http2|net|tls|dns|dgram|undici')).filter((f) => !NET[f])).toEqual([]);
  });
  test('fetch is used only where reviewed', () => {
    expect(matching(FETCH_USE).filter((f) => !FETCH[f])).toEqual([]);
  });
  test('the server never fetches a URL from a model: no fetch or http client in the API besides the reviewed PDF fetcher', () => {
    expect([...matching(FETCH_USE), ...matching(MODULE('http|https|http2|undici'))].filter((f) => f.startsWith('apps/api/') && f !== 'apps/api/src/assets/fetch.ts')).toEqual([]);
  });
  test('the rules see the forms review m2 named (double quotes, dynamic import, require, createRequire, window.fetch, an alias)', () => {
    for (const t of ['import https from "node:https";', "const h = await import('node:https');", "const cp = createRequire(import.meta.url)('node:child_process');", 'import {\n  spawn,\n} from "child_process";', "require('undici')"]) {
      expect(MODULE('http|https|http2|net|tls|dns|dgram|undici|child_process').test(t), t).toBe(true);
    }
    for (const t of ['window.fetch(url)', 'const get = fetch;', 'globalThis.fetch(u)', 'await fetch(u)']) expect(FETCH_USE.test(t), t).toBe(true);
    for (const t of ['cfg?.fetch?.allowHosts', "'/api/papers/:paperId/assets/fetch'", 'this.#boss.fetch<JobMessage>(name)', 'fetch?: FetchConfig', 'fetchSourcePdf(cfg, url)']) expect(FETCH_USE.test(t), t).toBe(false);
  });
  test('no code is built from strings at run time', () => {
    expect(matching(/\beval\s*\(|new\s+Function\s*\(|vm\.run(InNewContext|InThisContext|InContext)\s*\(/)).toEqual([]);
  });
});

describe('TST-059A: least privilege for child processes and credentials', () => {
  const SPAWN: Record<string, string> = {
    'apps/worker/src/provider-runs/sandboxed-launcher.ts': 'AI CLI inside bubblewrap with a built minimal env (RFC-010)',
    'apps/worker/src/lifecycle/index.ts': 'run process with the caller\'s minimal env and a lease marker (PW-028)',
    'apps/worker/src/pdf/extract.ts': 'PDF parser child under prlimit with an empty env (PW-035)',
    'packages/providers/src/core/launch.ts': 'provider launcher: env given by the adapter\'s allowlist (PW-024/025)',
    'packages/exports/src/pdf/index.ts': 'LibreOffice with its own HOME/profile and PATH-only env (PW-057)',
    'infra/sandbox/sandbox.ts': 'bubblewrap with a built environment (PW-026)',
    'infra/sandbox/forwarder.mjs': 'inside the sandbox: starts the CLI with the environment it was given (RFC-010)',
    'infra/sandbox/probe.mjs': 'sandbox self-test commands (PW-026)',
    'infra/backup/backup.ts': 'pg_dump / pg_restore with a built env: PATH and the PG* connection variables (the password there, never in argv) (PW-060)',
  };
  const importers = () => matching(MODULE('child_process'));
  // spawns that inherit on purpose: inside the sandbox, the environment is the one sandbox.ts built
  const INHERIT: Record<string, string> = {
    'infra/sandbox/forwarder.mjs': 'runs inside bubblewrap; it hands the CLI the environment the sandbox was started with (built by sandbox.ts)',
    'infra/sandbox/probe.mjs': 'runs inside bubblewrap as the self-test; its commands see only the sandbox\'s built environment',
  };
  test('child processes are started only from reviewed modules', () => {
    expect(importers().filter((f) => !SPAWN[f])).toEqual([]);
  });
  test('every spawn names its environment and none passes the server\'s own environment on', () => {
    for (const f of importers()) {
      const s = code(f);
      // the whole environment is never spread or copied onward (review m2: Object.assign, spreads)
      expect(s, `${f}: copies process.env`).not.toMatch(/\.\.\.\s*process\.env\b|Object\.assign\([^)]*process\.env|structuredClone\(\s*process\.env/);
      for (const m of s.matchAll(/(?<![\w.])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/g)) {
        const call = s.slice(m.index!, m.index! + 400);
        if (/^\w+\(cmd: string/.test(call)) continue; // a type or method signature, not a call
        if (INHERIT[f]) continue;
        expect(call, `${f}: ${call.slice(0, 80)}`).toMatch(/[{,]\s*env\s*[:,}]/); // env: … or the shorthand { env }
        expect(call, `${f}: inherits process.env`).not.toMatch(/env:\s*(\{\s*\.\.\.process\.env|process\.env)/);
      }
    }
  });
  test('credential file names appear only where reviewed, and are never read there', () => {
    const CRED = /\.credentials\.json|['"]auth\.json['"]|['"`/]\.(claude|codex)\/[^'"`]*(credentials|auth)/;
    const NAMED: Record<string, string> = {
      'apps/worker/src/provider-runs/index.ts': 'names the runtime login profile\'s credential files to bind-mount into the sandbox (RFC-010); the profile may not be developer CLI state (F-01)',
      'infra/sandbox/sandbox.ts': 'denies developer CLI state inside the sandbox (HOME_DENY) and plants a fake credential outside for its self-test',
      'infra/sandbox/probe.mjs': 'the self-test that tries to read the planted fake credential from inside the sandbox and must fail',
    };
    expect(matching(CRED).filter((f) => !NAMED[f])).toEqual([]);
    for (const f of Object.keys(NAMED)) expect(read(f), f).not.toMatch(/readFile(Sync)?\(\s*(source|path\.join\(loginProfile)/);
  });
  test('the browser keeps no session token, CSRF token or key in storage', () => {
    for (const f of tracked.filter((x) => x.startsWith('apps/web/src/') && /\.(ts|tsx)$/.test(x))) {
      for (const line of read(f).split('\n')) {
        // drafts and markers only (PW-015 local recovery); never a credential
        if (/setItem\(/.test(line)) expect(line, f).not.toMatch(/csrf|token|cookie|password|secret|apikey|api_key|credential/i);
      }
    }
  });
});
