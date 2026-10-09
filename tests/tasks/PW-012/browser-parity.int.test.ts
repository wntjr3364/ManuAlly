// PW-012 — TST-012A: the same fixtures give byte-identical results in the browser (Chromium) and on
// the server (Node): document validation, block hashes, grapheme boundaries, selection snapshots
// and replacement content. editor-core and the fixture runner are transpiled from the same sources
// and loaded in the page with the pinned prosemirror ESM builds.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import { chromium, type Browser } from '@playwright/test';
import * as core from '../../../packages/editor-core/src/index.ts';
import { fixtureReport } from './fixture-report.ts';

const root = path.resolve('.');
const resolvePkg = (name: string, from: string) => fs.realpathSync(path.join(from, 'node_modules', name));
const coreDir = path.join(root, 'packages/editor-core');
const pmModel = resolvePkg('prosemirror-model', coreDir);
const pmTransform = resolvePkg('prosemirror-transform', coreDir);
// pnpm places a package's own dependencies next to it
const orderedmap = fs.realpathSync(path.join(path.dirname(pmModel), 'orderedmap'));

function transpile(file: string): string {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true, verbatimModuleSyntax: false },
    fileName: file,
  }).outputText;
}

// URL path -> file; .ts sources are transpiled on the fly, vendor files served as they are
const routes: Record<string, () => string> = {
  '/vendor/prosemirror-model.js': () => fs.readFileSync(path.join(pmModel, 'dist/index.js'), 'utf8'),
  '/vendor/prosemirror-transform.js': () => fs.readFileSync(path.join(pmTransform, 'dist/index.js'), 'utf8'),
  '/vendor/orderedmap.js': () => fs.readFileSync(path.join(orderedmap, 'dist/index.js'), 'utf8'),
};
for (const f of fs.readdirSync(path.join(coreDir, 'src'))) routes[`/packages/editor-core/src/${f.replace(/\.ts$/, '.js')}`] = () => transpile(path.join(coreDir, 'src', f));
for (const f of ['fixtures.ts', 'fixture-report.ts']) routes[`/tests/tasks/PW-012/${f.replace(/\.ts$/, '.js')}`] = () => transpile(path.join(root, 'tests/tasks/PW-012', f));
routes['/index.html'] = () => `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{"prosemirror-model":"/vendor/prosemirror-model.js","prosemirror-transform":"/vendor/prosemirror-transform.js","orderedmap":"/vendor/orderedmap.js"}}</script>
<script type="module">
  import * as core from '/packages/editor-core/src/index.js';
  import { fixtureReport } from '/tests/tasks/PW-012/fixture-report.js';
  window.__report = fixtureReport(core).then((r) => JSON.stringify(r), (e) => 'ERROR ' + (e && e.stack || e));
</script>`;

let server: http.Server;
let browser: Browser;
let base: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = routes[(req.url ?? '').split('?')[0]!];
    if (!route) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': req.url!.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(route());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

describe('TST-012A: browser and server agree on every fixture', () => {
  test('Chromium and Node produce identical fixture reports', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => (window as unknown as { __report?: unknown }).__report !== undefined);
    const inBrowser = await page.evaluate(() => (window as unknown as { __report: Promise<string> }).__report);
    expect(errors).toEqual([]);
    expect(inBrowser.startsWith('ERROR'), inBrowser).toBe(false);
    const onServer = JSON.stringify(await fixtureReport(core));
    expect(JSON.parse(inBrowser)).toEqual(JSON.parse(onServer));
    expect(inBrowser).toBe(onServer);
    const ua = await page.evaluate(() => navigator.userAgent);
    expect(ua).toMatch(/Chrome\/\d+/);
  }, 60_000);
});
