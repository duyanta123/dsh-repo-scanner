import { scanRepository } from './index.mjs';
import { SCHEMA_VERSION, TOOL_VERSION, ANALYSIS_SCHEMA } from './options.mjs';

/**
 * v1.0 完整事实 API：为变更影响、测试洞察、文档同步提供
 * 基于统一扫描报告的派生事实。全部只读；结论均携带来源事实。
 */

function baseShell() {
  return {
    schema_version: SCHEMA_VERSION,
    analysis_schema: ANALYSIS_SCHEMA,
    tool: { name: 'dsh-repo-scanner', version: TOOL_VERSION },
  };
}

/**
 * 变更影响事实：
 * - changed_files：调用方提供的变更清单原样透传。
 * - impacted_files：沿内部依赖反向传播（import 了变更文件的文件），带传播深度。
 * - impacted_modules / impacted_symbols：受影响模块与变更文件内的符号。
 */
export async function getChangeImpactFacts(input = {}) {
  const report = await scanRepository({
    ...input,
    modes: input.modes ?? ['probe', 'files', 'scan', 'deps', 'symbols', 'git'],
  });

  const internal = report.dependencies.internal;
  const changedFiles = report.git?.changed_files ?? [];
  const changedPaths = new Set(
    changedFiles.map((f) => f.new_path || f.old_path).filter(Boolean),
  );

  // 反向依赖索引：target -> [source files]
  const reverse = new Map();
  for (const dep of internal) {
    if (!reverse.has(dep.target)) reverse.set(dep.target, []);
    reverse.get(dep.target).push(dep.source);
  }

  // BFS 反向传播，最大深度 3，避免大仓库爆炸。
  const impacted = new Map();
  let frontier = [...changedPaths];
  let depth = 0;
  while (frontier.length > 0 && depth < 3) {
    depth += 1;
    const next = [];
    for (const target of frontier) {
      for (const source of reverse.get(target) || []) {
        if (changedPaths.has(source) || impacted.has(source)) continue;
        impacted.set(source, { path: source, via: target, depth });
        next.push(source);
      }
    }
    frontier = next;
  }

  const impactedPaths = new Set(impacted.keys());
  const impactedModules = report.modules
    .filter((m) => (m.file_paths || []).some((p) => impactedPaths.has(p) || changedPaths.has(p)))
    .map((m) => ({ name: m.name, path: m.path, file_count: m.file_count }));

  const impactedSymbols = report.symbols
    .filter((s) => changedPaths.has(s.path))
    .slice(0, 200);

  return {
    ...baseShell(),
    changed_files: changedFiles,
    impacted_files: [...impacted.values()].sort((a, b) => a.path.localeCompare(b.path)),
    impacted_modules: impactedModules.sort((a, b) => a.path.localeCompare(b.path)),
    impacted_symbols: impactedSymbols,
    warnings: report.limits.warnings,
  };
}

/**
 * 测试洞察事实：
 * - test_files：测试文件 -> 被测源码文件的映射（按命名约定）。
 * - module_test_coverage：每个模块是否有对应测试。
 * - source_files_without_tests：没有任何测试指向的源码文件。
 */
export async function getTestInsightFacts(input = {}) {
  const report = await scanRepository({
    ...input,
    modes: input.modes ?? ['probe', 'files', 'scan'],
  });

  const sourceFiles = report.files.filter((f) => f.kind === 'source');
  const testFiles = report.files.filter((f) => f.kind === 'test');
  const sourceByBase = new Map();
  for (const file of sourceFiles) {
    const base = file.path.split('/').pop();
    if (!sourceByBase.has(base)) sourceByBase.set(base, []);
    sourceByBase.get(base).push(file.path);
  }

  const mappedTests = [];
  const coveredSources = new Set();
  const orphanTests = [];
  for (const test of testFiles) {
    const target = findTestTarget(test.path, sourceByBase, sourceFiles);
    if (target) {
      mappedTests.push({ test_file: test.path, target_file: target });
      coveredSources.add(target);
    } else {
      orphanTests.push(test.path);
    }
  }

  const testTargetsByModule = new Map();
  for (const { target_file } of mappedTests) testTargetsByModule.set(target_file, true);

  const moduleCoverage = report.modules.map((mod) => {
    const files = mod.file_paths || [];
    const hasTests = files.some((p) => testTargetsByModule.has(p));
    return {
      module: mod.path,
      name: mod.name,
      source_file_count: files.length,
      has_tests: hasTests,
      tested_files: files.filter((p) => testTargetsByModule.has(p)),
    };
  });

  return {
    ...baseShell(),
    test_files: mappedTests.sort((a, b) => a.test_file.localeCompare(b.test_file)),
    orphan_tests: orphanTests.sort(),
    module_test_coverage: moduleCoverage.sort((a, b) => a.module.localeCompare(b.module)),
    source_files_without_tests: sourceFiles
      .map((f) => f.path)
      .filter((p) => !coveredSources.has(p))
      .sort(),
    warnings: report.limits.warnings,
  };
}

function findTestTarget(testPath, sourceByBase, sourceFiles) {
  const base = testPath.split('/').pop();
  const ext = base.slice(base.lastIndexOf('.'));
  const stem = base.slice(0, base.length - ext.length);
  const normalized = normalizeTestStem(stem);
  if (!normalized) return null;

  const candidates = sourceByBase.get(`${normalized}${ext}`) || [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // 同名歧义：优先同目录，其次保持事实——返回 null 不猜。
    const dir = testPath.split('/').slice(0, -1).join('/');
    const sameDir = candidates.find((p) => p.split('/').slice(0, -1).join('/') === dir);
    return sameDir || null;
  }

  // 不同扩展名的同名源码（如 server.test.ts -> server.ts 之外再试 .js）。
  const anyExt = sourceFiles.filter((f) => {
    const fBase = f.path.split('/').pop();
    const fExt = fBase.slice(fBase.lastIndexOf('.'));
    return fBase === `${normalized}${fExt}`;
  });
  if (anyExt.length === 1) return anyExt[0].path;
  return null;
}

function normalizeTestStem(stem) {
  return stem
    .replace(/\.(test|spec)$/i, '')
    .replace(/[._-](test|spec)$/i, '')
    .replace(/^(test_|_test|tests_)/i, '');
}

/**
 * 文档同步事实：
 * - docs：每个文档引用了哪些源码路径。
 * - docs_with_stale_references：引用了已不存在源码文件的文档。
 * - source_files_without_doc_references：没有被任何文档引用的源码文件。
 */
export async function getDocSyncFacts(input = {}) {
  const report = await scanRepository({
    ...input,
    modes: input.modes ?? ['probe', 'files'],
  });

  // 文档正文只在内部使用（report.files 不携带 _text）。
  const rawFiles = report._files || [];
  const textByPath = new Map(rawFiles.map((f) => [f.path, f?._text ?? null]));

  const sourcePaths = new Set(report.files.filter((f) => f.kind === 'source').map((f) => f.path));
  const allPaths = new Set(report.files.map((f) => f.path));
  const docs = report.files.filter((f) => f.kind === 'docs');

  const referencedBy = new Map();
  const docsReport = [];
  const staleDocs = [];
  const staleReferences = [];
  const pathRe = /[A-Za-z0-9_.\-/]+\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|go|java|kt|kts|rb|php|rs)/g;

  for (const doc of docs) {
    const text = textByPath.get(doc.path) || '';
    const matches = new Set();
    let match;
    while ((match = pathRe.exec(text)) !== null) {
      const candidate = match[0].replace(/^\.\//, '');
      if (sourcePaths.has(candidate)) {
        matches.add(candidate);
      } else if (!allPaths.has(candidate)) {
        // 形似源码路径但在仓库中不存在：过期引用。
        staleReferences.push({ doc: doc.path, path: candidate });
      }
    }
    const referenced = [...matches].sort();
    for (const p of referenced) referencedBy.set(p, true);
    docsReport.push({ doc: doc.path, referenced_source_files: referenced, reference_count: referenced.length });
    if (staleReferences.some((s) => s.doc === doc.path)) staleDocs.push(doc.path);
  }

  return {
    ...baseShell(),
    docs: docsReport.sort((a, b) => a.doc.localeCompare(b.doc)),
    docs_with_stale_references: staleDocs.sort(),
    stale_references: staleReferences.sort((a, b) => a.doc.localeCompare(b.doc) || a.path.localeCompare(b.path)),
    source_files_without_doc_references: [...sourcePaths]
      .filter((p) => !referencedBy.has(p))
      .sort(),
    warnings: report.limits.warnings,
  };
}
