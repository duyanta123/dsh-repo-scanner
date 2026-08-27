import { SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION, ANALYSIS_SCHEMA, toPosixPath } from './options.mjs';
import { OutputValidationError } from './errors.mjs';

export function cleanFileEntry(file, options = {}) {
  const cleaned = {
    path: toPosixPath(file.path),
    kind: file.kind || 'unknown',
    language: file.language || null,
    bytes: Number.isFinite(file.bytes) ? file.bytes : 0,
    lines: file.lines ?? null,
  };
  if (options.hash === true) {
    cleaned.sha256 = file.sha256 ?? null;
  }
  return cleaned;
}

export function serializableInput(options) {
  return {
    repo_path: toPosixPath(options.repoPath) || '.',
    resolved_path: toPosixPath(options.resolvedPath || options.repoPath),
    options: {
      modes: options.modes || [],
      language: options.language || null,
      hash: options.hash === true,
      strict: options.strict === true,
      follow_symlinks: options.followSymlinks === true,
      cache: options.cache === true,
      parsers: options.parsers || ['heuristic'],
      symbol_query: options.symbolQuery || null,
    },
  };
}

/**
 * v1.0 性能预算：记录实测指标与预算，超限项列入 budget_exceeded。
 */
export function buildPerformance({ elapsedMs, files, limits, options }) {
  const budgets = {
    max_files: options.maxFiles,
    max_file_bytes: options.maxFileBytes,
    max_scan_ms: options.perfBudgetMs ?? null,
  };
  const exceeded = [];
  if (budgets.max_scan_ms != null && budgets.max_scan_ms > 0 && elapsedMs > budgets.max_scan_ms) {
    exceeded.push('max_scan_ms');
  }
  if (limits?.truncated === true) {
    exceeded.push('max_files');
  }
  return {
    elapsed_ms: Math.round(elapsedMs),
    files_indexed: files.length,
    bytes_read: limits?.bytes_read ?? 0,
    cache: {
      hits: limits?.cache_hits ?? 0,
      misses: limits?.cache_misses ?? 0,
    },
    budgets,
    budget_exceeded: exceeded,
  };
}

export function buildReport(scanResult) {
  const { options } = scanResult;
  const files = (scanResult.files || []).map((f) => cleanFileEntry(f, options));

  const warnings = [
    ...(scanResult.limits?.warnings || []),
    ...(scanResult.git?.warnings || []),
    ...(scanResult.warnings || []),
  ];

  const project = scanResult.project || {};

  const report = {
    schema_version: SCHEMA_VERSION,
    analysis_schema: ANALYSIS_SCHEMA,
    tool: {
      name: TOOL_NAME,
      version: TOOL_VERSION,
    },
    input: serializableInput(options),
    limits: {
      max_depth: options.maxDepth,
      max_files: options.maxFiles,
      max_file_bytes: options.maxFileBytes,
      truncated: scanResult.limits?.truncated === true,
      warnings,
    },
    project,
    files,
    modules: scanResult.modules || [],
    dependencies: {
      internal: scanResult.dependencies?.internal || [],
      external: scanResult.dependencies?.external || [],
    },
    entry_points: scanResult.entries?.entry_points || [],
    run_methods: scanResult.entries?.run_methods || [],
    symbols: scanResult.symbols || [],
    graphs: scanResult.graphs
      ? {
          module_call_graph: scanResult.graphs.module_call_graph || { nodes: [], edges: [] },
          symbol_references: scanResult.graphs.symbol_references || [],
        }
      : null,
    risks: scanResult.risks || [],
    errors: scanResult.errors || [],
    performance: scanResult.performance || null,
  };

  if (scanResult.git !== undefined) {
    report.git = {
      available: scanResult.git.available === true,
      head_ref: scanResult.git.head_ref || null,
      branch: scanResult.git.branch || null,
      head_sha: scanResult.git.head_sha || null,
      working_tree_clean: scanResult.git.working_tree_clean ?? null,
      changed_files: redactGitChangedFiles(scanResult.git.changed_files || []),
      compare: scanResult.git.compare || { base: null, head: null },
      method: scanResult.git.method || null,
      warnings: scanResult.git.warnings || [],
    };
  } else {
    report.git = null;
  }

  return redactReport(report);
}

function redactReport(report) {
  return {
    ...report,
    run_methods: report.run_methods.map((r) => ({ ...r, command: redactSecrets(r.command) })),
    risks: report.risks.map((r) => ({ ...r, detail: redactSecrets(r.detail) })),
  };
}

function redactGitChangedFiles(changedFiles) {
  return changedFiles.map((file) => ({
    ...file,
    hunks: (file.hunks || []).map((hunk) => ({
      ...hunk,
      lines: (hunk.lines || []).map((line) => redactSecrets(line)),
    })),
  }));
}

function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(
      /([a-zA-Z_][a-zA-Z0-9_-]*(?:password|passwd|secret|token|api[_-]?key))(\s*[=:]\s*)([^\s';,]+)/gi,
      '$1$2***',
    )
    .replace(
      /((?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp|amqps):\/\/[^:/@\s]+:)[^@\s]+@/gi,
      '$1***@',
    )
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '***');
}

export function validateReport(report) {
  const errors = [];
  if (report?.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}, got ${report?.schema_version}`);
  }
  if (!report || !Array.isArray(report.files) || !Array.isArray(report.modules) || !Array.isArray(report.symbols)) {
    errors.push('files/modules/symbols must be arrays');
  }
  if (!report?.dependencies || !Array.isArray(report.dependencies.internal) || !Array.isArray(report.dependencies.external)) {
    errors.push('dependencies.internal and dependencies.external must be arrays');
  }
  if (!report?.tool || report.tool.name !== TOOL_NAME) {
    errors.push('tool.name must be dsh-repo-scanner');
  }
  if (!report?.input || !report.input.resolved_path) {
    errors.push('input.resolved_path is required');
  }
  if (report?.graphs !== null && report?.graphs !== undefined) {
    if (!Array.isArray(report.graphs?.module_call_graph?.nodes)
      || !Array.isArray(report.graphs?.module_call_graph?.edges)
      || !Array.isArray(report.graphs?.symbol_references)) {
      errors.push('graphs.module_call_graph and graphs.symbol_references must be arrays');
    }
  }
  if (report?.performance !== null && report?.performance !== undefined) {
    if (typeof report.performance.elapsed_ms !== 'number' || !Array.isArray(report.performance.budget_exceeded)) {
      errors.push('performance.elapsed_ms must be a number and budget_exceeded must be an array');
    }
  }

  if (report?.files) {
    for (const file of report.files) {
      if (typeof file.path !== 'string' || file.path.includes('\\')) {
        errors.push(`file path must be a POSIX slash string: ${JSON.stringify(file?.path)}`);
        break;
      }
    }
  }

  if (errors.length > 0) {
    throw new OutputValidationError(errors.join('; '), errors);
  }
  return true;
}

export function serializeReport(report, format = 'json') {
  validateReport(report);
  if (format === 'jsonl') {
    return report.files.map((file) => JSON.stringify({ schema_version: report.schema_version, tool: report.tool, input: report.input, file })).join('\n');
  }
  return JSON.stringify(report, null, 2);
}
