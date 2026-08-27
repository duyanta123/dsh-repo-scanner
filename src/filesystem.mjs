import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toPosixPath } from './options.mjs';
import { ReadFailureWarning } from './errors.mjs';

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.py', '.go', '.java', '.kt', '.kts', '.rb', '.php', '.rs', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.cs', '.swift', '.scala',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf',
  '.md', '.mdx', '.rst', '.txt', '.css', '.scss', '.less', '.html', '.htm',
  '.graphql', '.gql', '.proto', '.sql', '.sh', '.ps1', '.bat', '.env', '.lock',
  '.gradle', '.properties', '.mk', '.cmake', '.mod', '.sum',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);

const SOURCE_EXTENSIONS = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.rb': 'ruby', '.php': 'php', '.rs': 'rust', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cs': 'csharp', '.swift': 'swift',
  '.scala': 'scala', '.sql': 'sql',
};

const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'cargo.toml', 'composer.json', 'gemfile',
  'requirements.txt', 'pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'rush.json',
]);

const CONFIG_NAME_PATTERNS = [
  /^tsconfig([^/]*)\.json$/i,
  /^jsconfig([^/]*)\.json$/i,
  /\.eslintrc(\.(js|cjs|mjs|json|yaml|yml))?$/i,
  /\.prettierrc(\.(js|cjs|mjs|json|yaml|yml|toml))?$/i,
  /^(jest|vitest|webpack|vite|rollup|babel|postcss|tailwind|eslint|prettier)\.config\./i,
  /\.config\.(js|mjs|cjs|ts|json)$/i,
  /^(dockerfile|makefile|\.gitignore|\.gitattributes|\.dockerignore|\.editorconfig|\.env\..*)$/i,
  /^docker-compose(.*)\.(yaml|yml)$/i,
  /^compose(.*)\.(yaml|yml)$/i,
];

const DOC_NAMES_PATTERNS = [/\.(md|mdx|rst|txt|adoc)$/i];
const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration', 'integration-test', 'unit']);
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\./i,
  /[._-](test|spec)$/i,
  /^(test_|_test|tests_)/i,
  /\.test\./i,
];

function isTextFile(ext) {
  return TEXT_EXTENSIONS.has(String(ext).toLowerCase());
}

export function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTENSIONS[ext] || null;
}

export function classifyFile(relativePath) {
  const posix = toPosixPath(relativePath);
  const base = posix.split('/').pop() || '';
  const ext = path.extname(base).toLowerCase();
  const lower = base.toLowerCase();

  if (MANIFEST_NAMES.has(lower)) return 'manifest';
  for (const pattern of CONFIG_NAME_PATTERNS) {
    if (pattern.test(base) || pattern.test(lower)) return 'config';
  }
  if (/^(openapi|swagger)(\.|[-_])?/i.test(lower) && /\.(json|yaml|yml)$/i.test(base)) return 'openapi';
  if (/\.(graphql|gql)$/i.test(base)) return 'graphql';
  if (isDbMigrationFile(posix, lower)) return 'db_migration';
  if (isTestFile(posix, lower)) return 'test';
  for (const pattern of DOC_NAMES_PATTERNS) {
    if (pattern.test(base)) return 'docs';
  }
  if (IMAGE_EXTENSIONS.has(ext) || /\.(woff2?|ttf|eot|otf|mp3|mp4|zip|gz|tar|tgz|pdf|bin|exe|dll|so|dylib|class|jar|war|whl|pyc|o|a)$/i.test(ext)) {
    return 'asset';
  }
  if (SOURCE_EXTENSIONS[ext]) return 'source';
  if (TEXT_EXTENSIONS.has(ext)) return 'config';
  return 'unknown';
}

function isDbMigrationFile(posixPath, lowerBase) {
  const segments = posixPath.toLowerCase().split('/');
  const migrationSegments = ['migrations', 'migration', 'migrate', 'db/migrations', 'db/migrate', 'alembic/versions', 'flyway/sql'];
  for (const segment of migrationSegments) {
    const parts = segment.split('/');
    for (let i = 0; i <= segments.length - parts.length; i += 1) {
      let matched = true;
      for (let j = 0; j < parts.length; j += 1) {
        if (segments[i + j] !== parts[j]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }
  return /(^|[_-])(migration|migrate)([_-]|$)/i.test(lowerBase);
}

function isTestFile(posixPath, lowerBase) {
  const segments = posixPath.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (TEST_DIR_NAMES.has(segments[i].toLowerCase())) return true;
  }
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(lowerBase));
}

function normalizeFileEntry(relPath, bytes, text, sha256, options) {
  const posix = toPosixPath(relPath);
  const language = detectLanguage(posix);
  const kind = classifyFile(posix);
  const entry = {
    path: posix,
    kind,
    language,
    bytes,
    lines: null,
  };

  if (options.hash) entry.sha256 = sha256 ?? null;

  if (text !== null) {
    // 以换行结尾的文件：末尾空段不计入行数。
    let lineCount = text.split(/\r?\n/).length;
    if (lineCount > 1 && /\r?\n$/.test(text)) lineCount -= 1;
    entry.lines = lineCount;
  }
  return entry;
}

function isDirAllowed(relDirPosix, includeDirs) {
  if (!includeDirs || includeDirs.length === 0) return true;
  const dir = relDirPosix || '.';
  return includeDirs.some((prefix) => {
    const p = String(prefix).replace(/\/+$/, '');
    if (p === '' || p === '.') return true;
    return dir === p || dir.startsWith(`${p}/`);
  });
}

function isFileContentAllowed(relDirPosix, includeDirs) {
  if (!includeDirs || includeDirs.length === 0) return true;
  if (!relDirPosix) return true;
  return isDirAllowed(relDirPosix, includeDirs);
}

export async function discoverFiles(inputOptions = {}) {
  const options = {
    repoPath: inputOptions.repoPath,
    includeDirs: inputOptions.includeDirs || [],
    excludeDirs: inputOptions.excludeDirs || [],
    maxDepth: inputOptions.maxDepth ?? 3,
    maxFiles: inputOptions.maxFiles ?? 2000,
    maxFileBytes: inputOptions.maxFileBytes ?? 256000,
    hash: inputOptions.hash === true,
    language: inputOptions.language || null,
    followSymlinks: inputOptions.followSymlinks === true,
    cache: inputOptions.cache || null,
  };

  const { repoPath } = options;
  const cache = options.cache;
  const metrics = { bytes_read: 0, cache_hits: 0, cache_misses: 0 };
  const files = [];
  const warnings = [];
  let truncated = false;
  const pendingDirs = [{ absDir: repoPath, relDir: '' }];

  async function walk(absDir, relDir) {
    if (files.length >= options.maxFiles) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      warnings.push(new ReadFailureWarning(toPosixPath(relDir || '.'), `readdir failed (${err.code || 'UNKNOWN'})`, 'E_READDIR_FAILED'));
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

    const fileBatch = [];
    for (const entry of entries) {
      if (entry.name === '.git' && relDir === '') continue;
      const childRel = relDir ? `${relDir}${path.sep}${entry.name}` : entry.name;
      const childRelPosix = toPosixPath(childRel);
      if (options.excludeDirs.some((dir) => matchesExcludedDir(childRelPosix, dir))) continue;
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        const real = await fs.promises.realpath(path.join(absDir, entry.name));
        if (!real.startsWith(repoPath)) continue;
      }
      if (entry.isDirectory()) {
        const depth = countDepth(childRel);
        if (depth > options.maxDepth) continue;
        if (!isDirAllowed(childRelPosix, options.includeDirs)) continue;
        fileBatch.push({ type: 'dir', abs: path.join(absDir, entry.name), rel: childRel });
      } else if (entry.isFile()) {
        if (!isFileContentAllowed(relDir ? toPosixPath(relDir) : '', options.includeDirs)) continue;
        if (options.language && detectLanguage(childRel) !== options.language && classifyFile(childRel) !== 'manifest') continue;
        fileBatch.push({ type: 'file', abs: path.join(absDir, entry.name), rel: childRel });
      }
    }

    for (const item of fileBatch) {
      if (files.length >= options.maxFiles) {
        truncated = true;
        break;
      }
      if (item.type === 'file') {
        const file = await buildFileEntry(item.abs, item.rel, options, warnings, cache, metrics);
        if (file) files.push(file);
      }
    }

    for (const item of fileBatch) {
      if (item.type === 'dir') {
        pendingDirs.push({ absDir: item.abs, relDir: item.rel });
      }
    }
  }

  while (pendingDirs.length > 0) {
    const next = pendingDirs.shift();
    if (files.length >= options.maxFiles) {
      truncated = true;
      break;
    }
    await walk(next.absDir, next.relDir);
  }

  return {
    repoPath,
    files,
    limits: {
      maxDepth: options.maxDepth,
      maxFiles: options.maxFiles,
      maxFileBytes: options.maxFileBytes,
      truncated,
      warnings: warnings.map((w) => ({ path: toPosixPath(w.path), message: w.message, code: w.code })),
      bytes_read: metrics.bytes_read,
      cache_hits: metrics.cache_hits,
      cache_misses: metrics.cache_misses,
    },
    metrics,
  };
}

async function buildFileEntry(absPath, relPath, options, warnings, cache, metrics) {
  let stat;
  try {
    stat = await fs.promises.stat(absPath);
  } catch (err) {
    warnings.push(new ReadFailureWarning(relPath, `stat failed (${err.code || 'UNKNOWN'})`, 'E_STAT_FAILED'));
    return null;
  }

  if (!stat.isFile()) return null;
  const bytes = stat.size;
  const ext = path.extname(absPath).toLowerCase();
  const posix = toPosixPath(relPath);
  const cacheableText = isTextFile(ext) && bytes <= options.maxFileBytes;
  const cached = cache?.get(posix) || null;
  const cacheHit = !!(cached && cached.size === bytes && cached.mtimeMs === stat.mtimeMs);

  let text = null;
  let sha256 = null;

  if (cacheHit && cached.text != null) {
    // 增量缓存命中：文本与（已计算的）哈希直接复用，不读盘。
    text = cached.text;
    if (options.hash) sha256 = cached.sha256 ?? null;
    metrics.cache_hits += 1;
  } else if (cacheHit && !cacheableText && options.hash && cached.sha256) {
    // 非文本文件缓存命中：只复用哈希。
    sha256 = cached.sha256;
    metrics.cache_hits += 1;
  } else if (cacheableText || options.hash) {
    let buf = null;
    try {
      buf = await fs.promises.readFile(absPath);
      metrics.bytes_read += buf.length;
      metrics.cache_misses += 1;
    } catch (err) {
      warnings.push(new ReadFailureWarning(relPath, `read failed (${err.code || 'UNKNOWN'})`, 'E_READ_FAILED'));
    }
    if (buf) {
      // sha256 始终按原始字节计算，避免 UTF-8 转码改变哈希值。
      if (options.hash) sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      if (cacheableText) text = stripBom(buf.toString('utf8'));
    }
  }

  const entry = normalizeFileEntry(posix, bytes, text, sha256, options);
  if (text !== null) {
    Object.defineProperty(entry, '_text', { value: text, enumerable: false, writable: true });
  }

  if (cache) {
    cache.set(posix, {
      mtimeMs: stat.mtimeMs,
      size: bytes,
      lines: entry.lines ?? (cacheHit && cached?.lines != null ? cached.lines : null),
      sha256: options.hash ? (sha256 ?? (cacheHit ? cached?.sha256 ?? null : null)) : null,
      text: cacheableText ? text : null,
      // v1.0 增量索引：符号结果随文件缓存一起保留，文件未变化时复用。
      symbols: cacheHit && cached?.symbols ? cached.symbols : null,
    });
  }

  return entry;
}

function stripBom(text) {
  // UTF-8 BOM 不参与行号与正则匹配。
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function matchesExcludedDir(childRelPosix, excludedName) {
  const segments = childRelPosix.split('/');
  const normalized = String(excludedName).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return false;
  return segments.includes(normalized);
}

function countDepth(relPath) {
  if (!relPath) return 0;
  return relPath.split(path.sep).length;
}

export function isTextPath(filePath) {
  return isTextFile(path.extname(filePath));
}