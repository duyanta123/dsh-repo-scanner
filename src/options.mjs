import path from 'node:path';
import fs from 'node:fs';
import { InvalidRepoPathError, PathTraversalError } from './errors.mjs';

export const TOOL_NAME = 'dsh-repo-scanner';
export const TOOL_VERSION = '0.1.0';
export const SCHEMA_VERSION = '1.0';
export const ANALYSIS_SCHEMA = Object.freeze({
  name: 'dsh-analysis-schema',
  version: '1.0',
});

export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 3,
  maxFiles: 2000,
  maxFileBytes: 256000,
});

export const DEFAULT_PERF_BUDGET_MS = 60000;

export const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  'vendor',
]);

const MODE_ALIASES = {
  probe: 'probe',
  files: 'files',
  file: 'files',
  scan: 'scan',
  modules: 'scan',
  module: 'scan',
  deps: 'deps',
  dependencies: 'deps',
  dependency: 'deps',
  entry: 'entry',
  entries: 'entry',
  'entry-points': 'entry',
  symbols: 'symbols',
  symbol: 'symbols',
  graphs: 'graphs',
  graph: 'graphs',
  git: 'git',
  all: 'all',
};

export const ALL_MODES = Object.freeze(['probe', 'files', 'scan', 'deps', 'entry', 'symbols', 'graphs', 'git']);

/**
 * 把 repoPath 规范化为绝对路径并验证其处于当前用户可读取的范围。
 *
 * 只读原则：这里只做 resolve/realpath，不做任何写入。
 */
export function normalizeRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') {
    throw new InvalidRepoPathError(String(repoPath), 'repository path must be a non-empty string');
  }

  let unsafePath = repoPath.trim();
  // Windows 路径兼容：Node 在 Windows 上可以处理两种分隔符，
  // 但包外路径可能来自 posix 字符串；仍然交给 path.resolve 处理。
  const resolved = path.resolve(unsafePath);

  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (err) {
    throw new InvalidRepoPathError(unsafePath, `repository path does not exist or cannot be read (${err.code || 'UNKNOWN'})`);
  }

  if (!stats.isDirectory()) {
    throw new InvalidRepoPathError(unsafePath, 'repository path is not a directory');
  }

  return resolved;
}

/**
 * 将跨平台路径转换为 POSIX `/` 分隔符并去掉首尾空白。
 */
export function toPosixPath(value) {
  if (value == null) return value;
  return String(value).replace(/\\/g, '/');
}

/**
 * 判断是否为 Windows 盘符（`C:\`/`C:/`）或 UNC（`\\server`）绝对路径。
 * POSIX 上 path.isAbsolute 认不出这些，必须独立检测以防越界。
 */
function isWindowsAbsolutePath(text) {
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\');
}

/**
 * 解析目录扫描范围，过滤空值和越界候选。
 */
function assertRelativeDir(dir) {
  if (dir == null || dir === '') return;
  const text = String(dir);
  if (path.isAbsolute(text) || isWindowsAbsolutePath(text) || text.split('/').includes('..') || text.split('\\').includes('..')) {
    throw new PathTraversalError(text, 'directory filters must stay inside repository');
  }
}

export function normalizeDirList(values) {
  if (values == null) return [];
  const raw = Array.isArray(values) ? values : String(values).split(',');
  const out = [];
  for (const item of raw) {
    if (item == null) continue;
    const text = String(item).trim();
    if (!text) continue;
    // 只剥离 './' 前缀；裸 '..' 保留原样，交由越界检查拒绝。
    const normalized = text.replace(/^\.\//, '');
    out.push(normalized);
  }
  return [...new Set(out)];
}

/**
 * 归一化库接口与 CLI 使用的选项。
 */
export function normalizeOptions(input = {}) {
  const rawRepoPath = input.repoPath ?? input.repo_path ?? '.';
  const repoPath = normalizeRepoPath(rawRepoPath);

  const requestedModes = normalizeModes(input.modes ?? (input.mode ? [input.mode] : ['all']));

  const includeDirs = normalizeDirList(input.includeDirs ?? input.include_dirs);
  const excludeDirs = normalizeDirList(input.excludeDirs ?? input.exclude_dirs);
  for (const dir of [...includeDirs, ...excludeDirs]) assertRelativeDir(dir);
  // 默认排除项始终存在；用户提供的 exclude_dirs 只增不减。
  const effectiveExcludeDirs = [...new Set([...DEFAULT_EXCLUDE_DIRS, ...excludeDirs])];

  const maxDepth = toNonNegativeInt(input.maxDepth ?? input.max_depth, DEFAULT_LIMITS.maxDepth);
  const maxFiles = toNonNegativeInt(input.maxFiles ?? input.max_files, DEFAULT_LIMITS.maxFiles);
  const maxFileBytes = toNonNegativeInt(input.maxFileBytes ?? input.max_file_bytes, DEFAULT_LIMITS.maxFileBytes);
  // v1.0 性能预算：扫描耗时超过该毫秒数时写入 limits.warnings；0 表示关闭。
  const perfBudgetMs = toNonNegativeInt(input.perfBudgetMs ?? input.perf_budget_ms, DEFAULT_PERF_BUDGET_MS);

  const language = normalizeLanguage(input.language);
  const hash = input.hash === true || input.hash === 'true' || input.hash === 1;
  const strict = input.strict === true || input.strict === 'true' || input.strict === 1;

  let git = {};
  if (input.git && typeof input.git === 'object') {
    git = {
      base: input.git.base ?? null,
      head: input.git.head ?? null,
      diffText: input.git.diffText ?? input.git.diff_text ?? null,
      changedFiles: input.git.changedFiles ?? input.git.changed_files ?? null,
      includeUntracked: input.git.includeUntracked !== false,
      statusText: input.git.statusText ?? input.git.status_text ?? null,
    };
  }

  const followSymlinks = input.followSymlinks === true || input.follow_symlinks === true;

  const cache = input.cache === true || input.cache === 'true' || input.cache === 1;
  const cacheDir = typeof input.cacheDir === 'string' && input.cacheDir.trim() !== ''
    ? input.cacheDir.trim()
    : input.cache_dir ?? null;

  // 符号查询：querySymbols 的过滤条件（CLI 透传）
  const symbolQuery = input.symbolQuery && typeof input.symbolQuery === 'object'
    ? {
        name: input.symbolQuery.name ?? null,
        file: input.symbolQuery.file ?? null,
        module: input.symbolQuery.module ?? null,
      }
    : null;

  // 解析器策略：可插拔解析器接口（v0.3）。
  // 可选 'tree-sitter'。若未安装，自动回退并写入 warnings。
  const parsers = normalizeParsers(input.parsers ?? input.parser ?? ['heuristic']);

  return {
    repoPath,
    resolvedPath: repoPath,
    modes: requestedModes,
    includeDirs,
    excludeDirs: effectiveExcludeDirs,
    maxDepth,
    maxFiles,
    maxFileBytes,
    perfBudgetMs,
    language,
    hash,
    strict,
    followSymlinks,
    cache,
    cacheDir,
    parsers,
    symbolQuery,
    git,
    // CLI 可能携带的展示参数
    format: input.format === 'jsonl' ? 'jsonl' : 'json',
  };
}

export function normalizeParsers(parsers) {
  if (parsers == null) return ['heuristic'];
  const raw = Array.isArray(parsers) ? parsers : String(parsers).split(',');
  const out = [];
  for (const item of raw) {
    if (item == null) continue;
    const key = String(item).trim().toLowerCase();
    if (!key) continue;
    if (key === 'heuristic' || key === 'regex') {
      out.push('heuristic');
    } else if (key === 'tree-sitter' || key === 'treesitter' || key === 'tree_sitter') {
      out.push('tree-sitter');
    } else {
      out.push(key);
    }
  }
  return [...new Set(out.length > 0 ? out : ['heuristic'])];
}

export function normalizeModes(modes) {
  if (modes == null) return ['all'];
  const raw = Array.isArray(modes) ? modes : String(modes).split(',');
  const out = [];
  for (const item of raw) {
    if (item == null) continue;
    const key = String(item).trim().toLowerCase();
    if (!key) continue;
    const mapped = MODE_ALIASES[key];
    if (!mapped) {
      out.push(key);
      continue;
    }
    out.push(mapped);
  }

  if (out.includes('all')) return [...ALL_MODES];

  const unique = [...new Set(out)];
  return unique;
}

export function normalizeLanguage(language) {
  if (language == null) return null;
  const text = String(language).trim().toLowerCase();
  const aliases = {
    js: 'javascript',
    javascript: 'javascript',
    ts: 'typescript',
    typescript: 'typescript',
    py: 'python',
    python: 'python',
    go: 'go',
    golang: 'go',
    java: 'java',
    kotlin: 'kotlin',
    kt: 'kotlin',
  };
  return aliases[text] || null;
}

function toNonNegativeInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * 安全拼接子路径：拒绝 `..`、绝对路径和空字节，避免越界。
 */
export function safeJoin(baseDir, relativePath) {
  if (relativePath == null) return baseDir;
  const text = String(relativePath);
  if (text.includes('\0')) throw new PathTraversalError(text, 'path contains null byte');
  if (path.isAbsolute(text) || isWindowsAbsolutePath(text)) throw new PathTraversalError(text, 'absolute path is not allowed');
  const candidate = path.resolve(baseDir, text);
  const rel = path.relative(baseDir, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathTraversalError(text, 'path escapes repository boundary');
  }
  return candidate;
}