// PW-001 — TST-001A / TST-001B
// Run: node --test tests/tasks/PW-001/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectPreflight, createRecordingFs } from '../../../spikes/preflight/preflight.mjs';

const created = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw001-'));
  created.push(d);
  return d;
}

const fakeTools = { node: 'v22.0.0', claude: null };
const runTool = (name) => (fakeTools[name] ? { found: true, version: fakeTools[name] } : { found: false, version: null });

test('TST-001A: report separates approved, undecided and protected paths', () => {
  const root = tmpdir();
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  const research = path.join(root, 'research-originals');
  fs.mkdirSync(research);
  fs.writeFileSync(path.join(research, 'raw.tsv'), 'gene\tvalue\n');

  const report = collectPreflight({
    dataRoot,
    approvedDataRoot: true,
    protectPaths: [research],
    home: root,
    runTool,
    toolNames: Object.keys(fakeTools),
  });

  assert.equal(report.data_root.status, 'approved');
  assert.equal(report.data_root.path, dataRoot);
  assert.ok(report.paths.protected.some((p) => p.path === research && p.exists === true));
  // default dev-CLI config dirs are always listed as protected, even when absent
  for (const name of ['.claude', '.codex']) {
    assert.ok(report.paths.protected.some((p) => p.path === path.join(root, name)), name);
  }
  assert.ok(report.paths.undecided.some((p) => p.kind === 'backup_location'));
  assert.equal(report.tools.node.found, true);
  assert.equal(report.tools.claude.found, false);
  assert.equal(report.scope, 'PREFLIGHT_ONLY_NOT_PRODUCT_TEST');
  // host-wide agent policy locations are always reported (presence only)
  assert.ok(report.paths.host_agent_policy.some((p) => p.path === '/etc/claude-code/managed-settings.json'));
});

test('TST-001A: data root given without user approval stays undecided', () => {
  const root = tmpdir();
  const report = collectPreflight({ dataRoot: root, approvedDataRoot: false, home: root, runTool, toolNames: [] });
  assert.equal(report.data_root.status, 'undecided');
});

test('TST-001A: protected paths are only stat-ed, never read or listed', () => {
  const root = tmpdir();
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{"secret":"SENTINEL"}');
  const rec = createRecordingFs(fs);
  const report = collectPreflight({ home: root, runTool, toolNames: [], fsApi: rec.fs });
  assert.ok(report.paths.protected.find((p) => p.path === claudeDir).exists);
  const touched = rec.calls.filter((c) => c.path.startsWith(claudeDir));
  assert.ok(touched.length > 0);
  for (const call of touched) assert.ok(['lstatSync', 'existsSync'].includes(call.op), `unexpected ${call.op} on ${call.path}`);
  assert.ok(!JSON.stringify(report).includes('SENTINEL'));
});

test('TST-001B: missing data root is blocked and never created', () => {
  const root = tmpdir();
  const missing = path.join(root, 'does-not-exist', 'paper-workspace');
  const report = collectPreflight({ dataRoot: missing, approvedDataRoot: true, home: root, runTool, toolNames: [] });
  assert.equal(report.data_root.status, 'blocked');
  assert.match(report.data_root.reason, /not exist/);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  assert.ok(report.blocked.some((b) => b.item === 'data_root'));
});

test('TST-001B: data root that is a file or a symlink is blocked', () => {
  const root = tmpdir();
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'x');
  const link = path.join(root, 'link');
  fs.symlinkSync(root, link);
  for (const candidate of [file, link]) {
    const report = collectPreflight({ dataRoot: candidate, approvedDataRoot: true, home: root, runTool, toolNames: [] });
    assert.equal(report.data_root.status, 'blocked', candidate);
  }
});

test('TST-001B: unknown free space blocks instead of guessing', () => {
  const root = tmpdir();
  const failingStatfs = { ...fs, statfsSync: () => { throw new Error('ENOSYS'); } };
  const report = collectPreflight({ dataRoot: root, approvedDataRoot: true, home: root, runTool, toolNames: [], fsApi: failingStatfs });
  assert.equal(report.data_root.status, 'blocked');
  assert.equal(report.data_root.free_bytes, null);
  assert.match(report.data_root.reason, /free space/);
});

test('TST-001B: insufficient free space is blocked', () => {
  const root = tmpdir();
  const tinyStatfs = { ...fs, statfsSync: () => ({ bavail: 1, bsize: 4096 }) };
  const report = collectPreflight({ dataRoot: root, approvedDataRoot: true, home: root, runTool, toolNames: [], fsApi: tinyStatfs, minFreeBytes: 10 * 1024 ** 3 });
  assert.equal(report.data_root.status, 'blocked');
  assert.match(report.data_root.reason, /free space/);
});
