import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  scanRepository,
  parseGitDiffText,
  parseGitStatusText,
  validateReport,
  getChangeImpactFacts,
  getTestInsightFacts,
  getDocSyncFacts,
} from '../src/index.mjs';

const fixture = (name) => path.resolve('test', 'fixtures', name);

test('normalizeOptions rejects invalid repository path', async () => {
  await assert.rejects(
    () => scanRepository({ repoPath: path.resolve('test', 'fixtures', 'does-not-exist') }),
    (err) => err.code === 'E_INVALID_REPO_PATH',
  );
});

test('probe: node fixture is detected as a typescript service with stable paths', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['probe'] });
  assert.equal(report.project.name, 'node-app');
  assert.equal(report.project.repo_type, 'service');
  assert.equal(report.project.language, 'typescript');
  assert.ok(report.project.manifest_files.includes('package.json'));
  assert.ok(report.files.some((f) => f.path === 'src/auth/service.ts'));
  assert.ok(report.files.every((f) => !f.path.includes('\\')), 'all paths must use POSIX separators');
  assert.ok(report.files.every((f) => !f.path.startsWith('node_modules/')));
  assert.ok(report.files.length > 0);
});

test('files: respects hidden excludes and returns byte/line facts', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['files'] });
  const pkg = report.files.find((f) => f.path === 'package.json');
  assert.equal(pkg.kind, 'manifest');
  assert.equal(pkg.language, null);
  assert.ok(pkg.bytes > 0);
  assert.ok(pkg.lines > 0);
  assert.equal(report.limits.max_depth, 3);
  assert.equal(report.limits.truncated, false);
});

test('scan: modules are recognized from conventional directories', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['scan'] });
  const paths = report.modules.map((m) => m.path);
  assert.ok(paths.includes('src/auth'));
  assert.ok(paths.includes('src/api'));

  const mono = await scanRepository({ repoPath: fixture('monorepo'), modes: ['scan'] });
  const monoPaths = mono.modules.map((m) => m.path);
  assert.ok(monoPaths.includes('packages/api'));
  assert.ok(monoPaths.includes('packages/ui'));

  const go = await scanRepository({ repoPath: fixture('go-app'), modes: ['scan'] });
  const goPaths = go.modules.map((m) => m.path);
  assert.ok(goPaths.includes('cmd/server'));
  assert.ok(goPaths.includes('internal/store'));
});

test('deps: internal relative imports resolve; manifest versions surface as external', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['deps'] });
  const internal = report.dependencies.internal;
  assert.ok(internal.some((d) => d.source === 'src/api/server.ts' && d.target === 'src/auth/service.ts'));
  const external = report.dependencies.external;
  assert.ok(external.some((d) => d.source === 'package.json' && d.package === 'express' && d.version === '^4.18.2'));

  assert.ok(internal.some((d) => Array.isArray(d.locations)));
  assert.ok(internal.every((d) => d.confidence === 'high' || d.confidence === 'medium'));
});

test('deps: python relative imports and go module imports are classified as internal', async () => {
  const py = await scanRepository({ repoPath: fixture('python-app'), modes: ['deps'] });
  assert.ok(py.dependencies.internal.some((d) => d.source === 'src/myapp/app.py' && d.target === 'src/myapp/auth.py'));

  const go = await scanRepository({ repoPath: fixture('go-app'), modes: ['deps'] });
  assert.ok(go.dependencies.internal.some((d) => d.source === 'cmd/server/main.go' && d.target === 'internal/store/store.go'));
  const goExternal = go.dependencies.external;
  assert.ok(goExternal.some((d) => d.source === 'go.mod' && d.package === 'github.com/gin-gonic/gin' && d.version === 'v1.9.1'));
});

test('entry: run methods carry source; web and cli entry points are detected', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['entry'] });
  assert.ok(report.run_methods.some((r) => r.source === 'package.json' && r.name === 'start'));
  assert.ok(report.entry_points.some((e) => e.type === 'web' && e.path === 'src/api/server.ts'));
  assert.ok(report.entry_points.some((e) => e.type === 'cli' && e.path === 'bin/cli.js'));

  const py = await scanRepository({ repoPath: fixture('python-app'), modes: ['entry'] });
  assert.ok(py.run_methods.some((r) => r.source === 'pyproject.toml' && r.command === 'myapp.cli:main'));
});

test('symbols: heuristic parser finds functions, classes and exports', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['symbols'] });
  assert.ok(report.symbols.some((s) => s.kind === 'class' && s.name === 'AuthService' && s.path === 'src/auth/service.ts'));
  assert.ok(report.symbols.some((s) => s.kind === 'function' && s.name === 'startServer'));
  assert.ok(report.symbols.some((s) => s.kind === 'export' && s.name === 'startServer'));

  const py = await scanRepository({ repoPath: fixture('python-app'), modes: ['symbols'] });
  assert.ok(py.symbols.some((s) => s.kind === 'class' && s.name === 'AuthService'));
  assert.ok(py.symbols.some((s) => s.kind === 'method' && s.name === 'login'));
});

test('git: diff/status text is parsed read-only with hunks and statuses', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,4 +1,5 @@',
    ' unchanged',
    '-old line',
    '+new line',
    '+another new line',
  ].join('\n');
  const parsed = parseGitDiffText(diff);
  assert.equal(parsed.changed_files.length, 1);
  assert.equal(parsed.changed_files[0].old_path, 'src/a.js');
  assert.equal(parsed.changed_files[0].new_path, 'src/a.js');
  assert.equal(parsed.changed_files[0].status, 'modified');
  assert.equal(parsed.changed_files[0].hunks.length, 1);
  assert.equal(parsed.changed_files[0].lines_added, 2);
  assert.equal(parsed.changed_files[0].lines_deleted, 1);

  const statuses = parseGitStatusText('M\tsrc/a.js\nA\tsrc/b.js\nR100\told.js\tnew.js\n?? untracked.js');
  assert.deepEqual(statuses.map((s) => s.status), ['modified', 'added', 'renamed', 'untracked']);
  assert.equal(statuses[2].old_path, 'old.js');
  assert.equal(statuses[2].new_path, 'new.js');
});

test('git: inspectGit returns metadata and optionally provided changed files', async () => {
  const report = await scanRepository({
    repoPath: fixture('node-app'),
    modes: ['git'],
    git: {
      statusText: 'M\tsrc/index.ts\n',
    },
    files: [],
  });
  assert.equal(report.git.available, false); // fixture 没有 .git，保持事实，不子进程
  assert.equal(report.git.changed_files.length, 1);
  assert.equal(report.git.changed_files[0].status, 'modified');
});

test('report contract validates and full all mode is serializable', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['all'] });
  assert.equal(report.schema_version, '1.0');
  assert.equal(report.tool.name, 'dsh-repo-scanner');
  assert.ok(Array.isArray(report.files));
  assert.ok(Array.isArray(report.modules));
  assert.ok(Array.isArray(report.dependencies.internal));
  assert.ok(Array.isArray(report.dependencies.external));
  assert.ok(report.files.every((f) => !f.path.includes('\\')));
  assert.doesNotThrow(() => validateReport(report));
});

test('cli: --probe prints json and exits 0 for valid repo', (t) => {
  const cli = path.resolve('bin', 'repo-scanner.mjs');
  const target = fixture('node-app');
  const result = spawnSync(process.execPath, [cli, target, '--probe', '--json'], { encoding: 'utf8' });
  if (result.error?.code === 'EPERM') {
    t.skip('child process spawning is blocked in this sandbox');
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schema_version, '1.0');
  assert.equal(parsed.project.name, 'node-app');
  assert.ok(parsed.files.some((f) => f.path === 'package.json'));
});

test('cli: missing path exits 2 with json error', (t) => {
  const cli = path.resolve('bin', 'repo-scanner.mjs');
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  if (result.error?.code === 'EPERM') {
    t.skip('child process spawning is blocked in this sandbox');
    return;
  }
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.tool.name, 'dsh-repo-scanner');
  assert.ok(parsed.error.message);
});

// ---------------------------------------------------------------------------
// v0.2：增量缓存、别名解析、API 契约识别、符号查询
// ---------------------------------------------------------------------------

test('deps: tsconfig paths resolve via extends chain and multiple targets', async () => {
  const report = await scanRepository({ repoPath: fixture('ts-alias-app'), modes: ['deps'] });
  const internal = report.dependencies.internal;
  // 第一个 target（src/*）命中。
  assert.ok(internal.some((d) => d.source === 'src/api/index.ts' && d.target === 'src/util/helper.ts'
    && d.resolution === 'tsconfig paths: @/*'));
  // 第二个 target（lib/*）在 src 下不存在时回退命中。
  assert.ok(internal.some((d) => d.target === 'lib/legacy/old.ts'));
  // extends 的父配置 paths 同样生效。
  assert.ok(internal.some((d) => d.target === 'src/shared/consts.ts'
    && d.resolution === 'tsconfig paths: @shared/*'));
});

test('probe: openapi/graphql/db migration files are surfaced as project facts', async () => {
  const mono = await scanRepository({ repoPath: fixture('monorepo'), modes: ['probe'] });
  assert.ok(mono.project.openapi_files.includes('openapi.yaml'));
  assert.ok(mono.project.graphql_files.includes('schema.graphql'));
  assert.ok(mono.project.db_migration_files.includes('db/migrations/001_init.sql'));
  // 空集合返回 []，不使用其他空值表达。
  const node = await scanRepository({ repoPath: fixture('node-app'), modes: ['probe'] });
  assert.deepEqual(node.project.openapi_files, []);
});

test('symbols: query filters by name, file and module', async () => {
  const byName = await scanRepository({ repoPath: fixture('node-app'), modes: ['symbols'], symbolQuery: { name: 'authservice' } });
  assert.ok(byName.symbols.length > 0);
  assert.ok(byName.symbols.every((s) => s.name.toLowerCase().includes('authservice')));

  const byModule = await scanRepository({ repoPath: fixture('node-app'), modes: ['symbols'], symbolQuery: { module: 'auth' } });
  assert.ok(byModule.symbols.length > 0);
  assert.ok(byModule.symbols.every((s) => s.path.startsWith('src/auth/')));

  const byFile = await scanRepository({ repoPath: fixture('node-app'), modes: ['symbols'], symbolQuery: { file: 'service.ts' } });
  assert.ok(byFile.symbols.length > 0);
  assert.ok(byFile.symbols.every((s) => s.path.endsWith('service.ts')));
});

test('cache: second scan reuses text and symbol results incrementally', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scanner-test-'));
  try {
    const input = { repoPath: fixture('node-app'), modes: ['symbols'], cache: true, cacheDir };
    const first = await scanRepository(input);
    const second = await scanRepository(input);

    assert.equal(first.performance.cache.hits, 0);
    assert.ok(first.performance.cache.misses > 0);
    assert.ok(second.performance.cache.hits > 0, 'second run should hit the scan cache');
    // 缓存命中不改变结果：可复现性保持。
    assert.deepEqual(second.files.map((f) => f.path), first.files.map((f) => f.path));
    assert.deepEqual(second.symbols, first.symbols);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.3：可插拔解析器、图分析、dsh-analysis-schema
// ---------------------------------------------------------------------------

test('parsers: unavailable tree-sitter falls back to heuristic with warning', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['symbols'], parsers: ['tree-sitter'] });
  assert.ok(report.symbols.length > 0, 'symbols must still be produced by fallback parser');
  assert.ok(report.symbols.every((s) => s.parser === 'heuristic'));
  assert.ok(report.limits.warnings.some((w) => w.code === 'E_PARSER_UNAVAILABLE'));
});

test('graphs: module call graph aggregates internal deps to module level', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['graphs'] });
  const edges = report.graphs.module_call_graph.edges;
  assert.ok(edges.some((e) => e.source === 'src/api' && e.target === 'src/auth' && e.weight >= 1));
  // 模块内部依赖不产生自环。
  assert.ok(edges.every((e) => e.source !== e.target));
});

test('graphs: symbol references resolve named imports to target exports', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['graphs'] });
  const refs = report.graphs.symbol_references;
  assert.ok(refs.some((r) => r.source_file === 'src/api/server.ts' && r.target_file === 'src/auth/service.ts'
    && r.symbol === 'AuthService' && r.confidence === 'high'));
  assert.ok(refs.some((r) => r.source_file === 'test/server.test.ts' && r.target_file === 'src/api/server.ts'
    && r.symbol === 'startServer'));

  const py = await scanRepository({ repoPath: fixture('python-app'), modes: ['graphs'] });
  assert.ok(py.graphs.symbol_references.some((r) => r.source_file === 'src/myapp/app.py'
    && r.target_file === 'src/myapp/auth.py' && r.symbol === 'AuthService' && r.confidence === 'high'));
});

test('report: analysis_schema is part of the v1.0 shell', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['probe'] });
  assert.equal(report.analysis_schema.name, 'dsh-analysis-schema');
  assert.equal(report.analysis_schema.version, '1.0');
});

// ---------------------------------------------------------------------------
// v1.0：性能预算、git 判定、事实 API
// ---------------------------------------------------------------------------

test('performance: budget overrun is reported and can be disabled', async () => {
  const slow = await scanRepository({ repoPath: fixture('node-app'), modes: ['all'], perfBudgetMs: 1 });
  assert.ok(slow.performance.budget_exceeded.includes('max_scan_ms'));
  assert.ok(slow.limits.warnings.some((w) => w.code === 'E_PERF_BUDGET_EXCEEDED'));
  assert.ok(slow.performance.elapsed_ms >= 0);
  assert.equal(slow.performance.files_indexed, slow.files.length);

  const off = await scanRepository({ repoPath: fixture('node-app'), modes: ['probe'], perfBudgetMs: 0 });
  assert.ok(!off.performance.budget_exceeded.includes('max_scan_ms'));
  assert.ok(!off.limits.warnings.some((w) => w.code === 'E_PERF_BUDGET_EXCEEDED'));
});

test('git: working_tree_clean derived from status text; compare refs recorded', async () => {
  const clean = await scanRepository({ repoPath: fixture('node-app'), modes: ['git'], git: { statusText: '' } });
  assert.equal(clean.git.working_tree_clean, true);
  assert.deepEqual(clean.git.changed_files, []);

  const dirty = await scanRepository({ repoPath: fixture('node-app'), modes: ['git'], git: { statusText: 'M\tsrc/index.ts\n' } });
  assert.equal(dirty.git.working_tree_clean, false);

  const refs = await scanRepository({
    repoPath: fixture('node-app'),
    modes: ['git'],
    git: { statusText: 'M\tsrc/index.ts\n', base: 'HEAD~1', head: 'HEAD' },
  });
  assert.equal(refs.git.compare.base, 'HEAD~1');
  assert.equal(refs.git.compare.head, 'HEAD');
});

test('facts: change impact propagates through reverse dependencies', async () => {
  const facts = await getChangeImpactFacts({
    repoPath: fixture('node-app'),
    git: { statusText: 'M\tsrc/auth/service.ts\n' },
  });
  assert.ok(facts.changed_files.some((f) => f.new_path === 'src/auth/service.ts'));
  assert.ok(facts.impacted_files.some((f) => f.path === 'src/api/server.ts' && f.via === 'src/auth/service.ts'));
  assert.ok(facts.impacted_modules.some((m) => m.path === 'src/api'));
  assert.ok(facts.impacted_symbols.some((s) => s.path === 'src/auth/service.ts' && s.name === 'AuthService'));
});

test('facts: test insight maps test files to sources and module coverage', async () => {
  const facts = await getTestInsightFacts({ repoPath: fixture('node-app') });
  assert.ok(facts.test_files.some((t) => t.test_file === 'test/server.test.ts' && t.target_file === 'src/api/server.ts'));
  const auth = facts.module_test_coverage.find((m) => m.module === 'src/auth');
  assert.equal(auth.has_tests, false);
  assert.ok(facts.source_files_without_tests.includes('src/index.ts'));

  const py = await getTestInsightFacts({ repoPath: fixture('python-app') });
  assert.ok(py.test_files.some((t) => t.test_file === 'tests/test_app.py' && t.target_file === 'src/myapp/app.py'));
});

test('facts: doc sync reports references and stale references', async () => {
  const facts = await getDocSyncFacts({ repoPath: fixture('node-app') });
  const readme = facts.docs.find((d) => d.doc === 'README.md');
  assert.ok(readme.referenced_source_files.includes('src/api/server.ts'));
  assert.ok(readme.referenced_source_files.includes('src/auth/service.ts'));
  assert.ok(facts.docs_with_stale_references.includes('README.md'));
  assert.ok(facts.stale_references.some((s) => s.doc === 'README.md' && s.path === 'src/api/removed.ts'));
});

test('files: line count ignores trailing newline', async () => {
  const report = await scanRepository({ repoPath: fixture('node-app'), modes: ['files'] });
  const readme = report.files.find((f) => f.path === 'README.md');
  assert.equal(readme.lines, 7);
});