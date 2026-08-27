import { normalizeOptions, ALL_MODES, ANALYSIS_SCHEMA, TOOL_NAME, TOOL_VERSION, SCHEMA_VERSION, DEFAULT_LIMITS, DEFAULT_EXCLUDE_DIRS } from './options.mjs';
import { discoverFiles } from './filesystem.mjs';
import { probeProject } from './probe.mjs';
import { scanModules } from './modules.mjs';
import { analyzeDependencies } from './dependencies.mjs';
import { detectEntryPoints } from './entries.mjs';
import { extractSymbols, querySymbols } from './symbols.mjs';
import { inspectGit } from './git.mjs';
import { buildGraphs } from './graphs.mjs';
import { buildReport, validateReport, buildPerformance } from './output.mjs';
import { createScanCache } from './cache.mjs';
import { InvalidRepoPathError, OutputValidationError } from './errors.mjs';

/**
 * 库入口：扫描仓库并返回统一外壳报告。
 *
 * @param {object} input 扫描配置
 * @returns {Promise<object>} 统一输出契约 JSON
 */
export async function scanRepository(input = {}) {
  const options = normalizeOptions(input);
  const modes = options.modes;
  const startedAt = Date.now();

  // v0.2 增量扫描缓存：可选开启，只写系统临时目录，不写目标仓库。
  let cache = null;
  if (options.cache) {
    cache = await createScanCache(options);
    await cache.load();
  }

  // 始终先做安全遍历：probe/scan/deps/entry/symbols/graphs 都依赖文件索引。
  const discovered = await discoverFiles({ ...options, cache });
  const files = discovered.files;
  const limits = discovered.limits;

  const scanWarnings = [];
  const project = probeProject(files, { repoPath: options.repoPath, options });
  const context = {
    repoPath: options.repoPath,
    options,
    project,
    files,
    cache,
    warnings: scanWarnings,
  };

  const needsModules = modes.includes('scan')
    || modes.includes('probe')
    || modes.includes('deps')
    || modes.includes('graphs')
    || options.symbolQuery?.module != null;
  const modules = needsModules ? scanModules(files, context) : [];

  const needsDeps = modes.includes('deps') || modes.includes('graphs');
  const deps = needsDeps
    ? analyzeDependencies(files, modules, context)
    : { dependencies: { internal: [], external: [] }, risks: [] };

  const entries = modes.includes('entry')
    ? detectEntryPoints(files, context)
    : { entry_points: [], run_methods: [] };

  const needsSymbols = modes.includes('symbols') || modes.includes('graphs');
  let symbols = [];
  if (needsSymbols) {
    // v1.0 增量索引：符号结果按文件缓存，未变化文件直接复用。
    symbols = await extractSymbols(files, context);
    if (options.symbolQuery) {
      symbols = querySymbols(symbols, options.symbolQuery, modules);
    }
  }

  let git;
  if (modes.includes('git')) {
    git = inspectGit(options.repoPath, {
      git: options.git || {},
      files,
    });
  }

  // v0.3 图分析：依赖模块、内部依赖与符号索引。
  let graphs;
  if (modes.includes('graphs')) {
    graphs = buildGraphs({
      files,
      modules,
      internal: deps.dependencies.internal,
      symbols,
    });
  }

  // v1.0 性能预算：实测耗时与预算对比，超限写入 warnings。
  const elapsedMs = Date.now() - startedAt;
  const performance = buildPerformance({ elapsedMs, files, limits, options });
  const perfWarnings = performance.budget_exceeded.includes('max_scan_ms')
    ? [{ code: 'E_PERF_BUDGET_EXCEEDED', message: `scan exceeded perf budget: ${elapsedMs}ms > ${options.perfBudgetMs}ms` }]
    : [];

  const report = buildReport({
    options,
    limits: { ...limits, warnings: [...limits.warnings, ...perfWarnings, ...scanWarnings] },
    project,
    files,
    modules,
    dependencies: deps.dependencies,
    entries,
    symbols,
    graphs,
    risks: deps.risks || [],
    git,
    errors: [],
    performance,
  });

  // 事实 API 的内部通道：携带 _text 的原始文件索引（不参与序列化输出）。
  Object.defineProperty(report, '_files', { value: files, enumerable: false });

  if (options.strict) validateReport(report);
  if (cache) await cache.save();
  return report;
}

export {
  normalizeOptions,
  discoverFiles,
  probeProject,
  scanModules,
  analyzeDependencies,
  detectEntryPoints,
  extractSymbols,
  querySymbols,
  inspectGit,
  buildGraphs,
  buildReport,
  buildPerformance,
  validateReport,
  createScanCache,
  InvalidRepoPathError,
  OutputValidationError,
  ALL_MODES,
  ANALYSIS_SCHEMA,
  TOOL_NAME,
  TOOL_VERSION,
  SCHEMA_VERSION,
  DEFAULT_LIMITS,
  DEFAULT_EXCLUDE_DIRS,
};

export { parseGitDiffText, parseGitStatusText } from './git.mjs';
export { resolveImportTarget } from './dependencies.mjs';
export { registerParser, listParsers } from './parsers.mjs';
export { getChangeImpactFacts, getTestInsightFacts, getDocSyncFacts } from './facts.mjs';
