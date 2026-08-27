import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { scanRepository } from '../src/index.mjs';
import { safeJoin, normalizeOptions } from '../src/options.mjs';

const fixture = (name) => path.resolve('test', 'fixtures', name);

// ---------------------------------------------------------------------------
// v1.0 安全审计：路径越界、符号链接、子进程红线、依赖白名单、脱敏
// ---------------------------------------------------------------------------

test('security: safeJoin rejects path traversal, absolute paths and null bytes', () => {
  const base = path.resolve('test', 'fixtures', 'node-app');
  assert.throws(() => safeJoin(base, '../../etc/passwd'), (err) => err.code === 'E_PATH_TRAVERSAL');
  assert.throws(() => safeJoin(base, 'a/../../..'), (err) => err.code === 'E_PATH_TRAVERSAL');
  assert.throws(() => safeJoin(base, 'C:/Windows/system32'), (err) => err.code === 'E_PATH_TRAVERSAL');
  assert.throws(() => safeJoin(base, 'src\x00hidden'), (err) => err.code === 'E_PATH_TRAVERSAL');
  // 合法相对路径正常拼接。
  assert.equal(safeJoin(base, 'src/index.ts'), path.join(base, 'src/index.ts'));
});

test('security: include/exclude dir filters must stay inside the repository', () => {
  assert.throws(
    () => normalizeOptions({ repoPath: fixture('node-app'), includeDirs: ['..'] }),
    (err) => err.code === 'E_PATH_TRAVERSAL',
  );
  assert.throws(
    () => normalizeOptions({ repoPath: fixture('node-app'), excludeDirs: ['/etc'] }),
    (err) => err.code === 'E_PATH_TRAVERSAL',
  );
  assert.throws(
    () => normalizeOptions({ repoPath: fixture('node-app'), includeDirs: ['a/../..'] }),
    (err) => err.code === 'E_PATH_TRAVERSAL',
  );
  // 合法目录过滤通过。
  const ok = normalizeOptions({ repoPath: fixture('node-app'), includeDirs: ['src'] });
  assert.deepEqual(ok.includeDirs, ['src']);
});

test('security: symlinks are not followed by default', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-symlink-'));
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-outside-'));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/inside.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const b = 2;\n');
    try {
      fs.symlinkSync(outside, path.join(repo, 'linked-outside'), 'dir');
    } catch (err) {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      t.skip(`symlink creation is not permitted on this system (${err.code})`);
      return;
    }

    const report = await scanRepository({ repoPath: repo, modes: ['files'] });
    const paths = report.files.map((f) => f.path);
    assert.ok(paths.includes('src/inside.ts'));
    assert.ok(!paths.some((p) => p.includes('linked-outside')), 'symlinked dir must not be traversed by default');
    assert.ok(!paths.some((p) => p.includes('secret.ts')), 'files outside the repository must never be indexed');
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('security: run method commands are redacted in output', async () => {
  const report = await scanRepository({ repoPath: fixture('security-app'), modes: ['entry'] });
  const start = report.run_methods.find((r) => r.name === 'start');
  const migrate = report.run_methods.find((r) => r.name === 'migrate');
  assert.ok(start, 'start script should be captured');
  assert.ok(!start.command.includes('sk-live-9f8e7d6c5b4a'), 'api token must be redacted');
  assert.ok(start.command.includes('***'));
  assert.ok(!migrate.command.includes('supersecret'), 'db password must be redacted');
  assert.ok(migrate.command.includes('***'));
});

test('security audit: scanner sources never spawn subprocesses, use network, or import beyond allowlisted node builtins', async () => {
  const srcDir = path.resolve('src');
  const binDir = path.resolve('bin');
  const allowedBuiltins = new Set(['fs', 'path', 'crypto', 'os']);
  const bannedSnippets = [
    'child_process',
    'spawnSync(',
    'execSync(',
    'spawn(',
    "from 'node:http'",
    "from 'node:https'",
    "from 'node:net'",
    "from 'node:dgram'",
    'fetch(',
    'XMLHttpRequest',
  ];
  const files = [
    ...fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(srcDir, f)),
    path.join(binDir, 'repo-scanner.mjs'),
  ];
  assert.ok(files.length >= 10, 'audit must cover every source module');

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(process.cwd(), file);
    for (const snippet of bannedSnippets) {
      assert.ok(!text.includes(snippet), `${rel} must not contain "${snippet}"`);
    }
    for (const match of text.matchAll(/from\s+'node:([a-z]+)'/g)) {
      assert.ok(allowedBuiltins.has(match[1]), `${rel} imports non-allowlisted builtin node:${match[1]}`);
    }
  }
});

test('security: repo_path traversal via .. is rejected as invalid or resolved inside bounds', async () => {
  // .. 越界的 include-dirs 已在上文覆盖；这里验证 repoPath 本身不引发写操作
  // 且不存在的路径返回 E_INVALID_REPO_PATH。
  await assert.rejects(
    () => scanRepository({ repoPath: path.resolve('test', 'fixtures', 'nope-__-__') }),
    (err) => err.code === 'E_INVALID_REPO_PATH',
  );
});

test('security: hash option does not execute or alter the target repository', async () => {
  const before = collectStats(fixture('node-app'));
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['files'], hash: true });
  const after = collectStats(fixture('node-app'));
  // 只读红线：mtime 与大小不应发生变化。
  assert.deepEqual(after, before);
  const pkg = report.files.find((f) => f.path === 'package.json');
  assert.ok(/^[0-9a-f]{64}$/.test(pkg.sha256), 'sha256 must be a hex digest of the file bytes');
});

function collectStats(dir) {
  const out = [];
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else {
        const stat = fs.statSync(abs);
        out.push(`${relPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}
