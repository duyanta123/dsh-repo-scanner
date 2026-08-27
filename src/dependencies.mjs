import path from 'node:path';
import { toPosixPath } from './options.mjs';

const JS_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs', '/index.json'];

// 同一个 files 数组的解析上下文（文件索引 + tsconfig 别名）只构建一次，
// 供依赖分析与图分析复用。
const RESOLVE_CACHE = new WeakMap();

function textOf(file) {
  return file?._text ?? null;
}

function getResolveContext(files) {
  let ctx = RESOLVE_CACHE.get(files);
  if (!ctx) {
    ctx = {
      fileIndex: new Map(files.map((f) => [f.path, f])),
      tsAliases: loadTsAliases(files),
    };
    RESOLVE_CACHE.set(files, ctx);
  }
  return ctx;
}

/**
 * 分析内部/外部依赖。文件文本来自扫描阶段缓存，只读一遍。
 */
export function analyzeDependencies(files, modules = [], context = {}) {
  const { fileIndex, tsAliases } = getResolveContext(files);
  const internal = [];
  const external = [];
  const risks = [];

  for (const file of files) {
    if (!file.language || (file.kind !== 'source' && file.kind !== 'test')) continue;
    const text = textOf(file);
    if (text == null) continue;
    const rows = findImportRows(file.path, file.language, text);
    for (const row of rows) {
      if (row.riskType) {
        risks.push({ type: row.riskType, path: file.path, line: row.line, detail: row.detail, confidence: 'high' });
        continue;
      }
      const resolved = resolveInternal(row, fileIndex, tsAliases);
      if (resolved) {
        internal.push({
          source: file.path,
          target: resolved.path,
          kind: row.kind,
          spec: row.spec,
          line: row.line,
          confidence: resolved.confidence,
          resolution: resolved.resolution,
        });
      } else {
        external.push({
          source: file.path,
          package: externalPackageName(row.spec, row.language),
          version: lookupPackageVersion(row.spec, fileIndex),
          spec: row.spec,
          line: row.line,
          kind: row.kind,
          confidence: row.spec ? 'high' : 'medium',
        });
      }
    }
  }

  external.push(...extractManifestDependencies(files));

  return {
    dependencies: {
      internal: mergeInternal(internal),
      external: dedupeExternal(external),
    },
    risks,
  };
}

/**
 * 供图分析等模块复用：把 import spec 解析为仓库内目标路径（无法解析时返回 null）。
 */
export function resolveImportTarget(files, sourcePath, spec, language) {
  const { fileIndex, tsAliases } = getResolveContext(files);
  const resolved = resolveInternal({ sourcePath, spec, language }, fileIndex, tsAliases);
  return resolved ? resolved.path : null;
}

function findImportRows(filePath, language, text) {
  const rows = [];
  const posixPath = toPosixPath(filePath);

  if (language === 'javascript' || language === 'typescript') {
    const patterns = [
      { regex: /\bimport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g, kind: 'import' },
      { regex: /\bimport\s+['"]([^'"]+)['"]/g, kind: 'import' },
      { regex: /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g, kind: 'import' },
      { regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'import' },
      { regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'require' },
    ];
    for (const { regex, kind } of patterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const line = countLineAt(text, match.index) + 1;
        rows.push({ language, sourcePath: posixPath, spec: match[1], kind, line });
      }
    }
    // 动态 import() / require()：仅报告为风险，不猜测 target。
    const dynamicRisks = [
      { regex: /\bimport\s*\(\s*(?!['"])/g, type: 'dynamic_import', label: 'dynamic import() expression' },
      { regex: /\brequire\s*\(\s*(?!['"])/g, type: 'dynamic_require', label: 'dynamic require() expression' },
    ];
    for (const { regex, type, label } of dynamicRisks) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const line = countLineAt(text, match.index) + 1;
        rows.push({ language, sourcePath: posixPath, spec: null, kind: null, line, riskType: type, detail: label });
      }
    }
  } else if (language === 'python') {
    const importRe = /^\s*import\s+(.+?)(?:\s+#.*)?$/gm;
    let match;
    while ((match = importRe.exec(text)) !== null) {
      const line = countLineAt(text, match.index) + 1;
      for (const moduleName of String(match[1]).split(/\s*,\s*/)) {
        const name = moduleName.trim().split(/\s+as\s+/)[0].trim();
        if (name) rows.push({ language, sourcePath: posixPath, spec: name, kind: 'import', line });
      }
    }
    const fromRe = /^\s*from\s+([^\s]+)\s+import\s+.+$/gm;
    while ((match = fromRe.exec(text)) !== null) {
      const line = countLineAt(text, match.index) + 1;
      rows.push({ language, sourcePath: posixPath, spec: match[1], kind: 'import', line });
    }
  } else if (language === 'go') {
    rows.push(...parseGoImports(posixPath, text));
  } else if (language === 'java' || language === 'kotlin') {
    const importRe = /^\s*import\s+([^;]+);\s*$/gm;
    let match;
    while ((match = importRe.exec(text)) !== null) {
      const line = countLineAt(text, match.index) + 1;
      rows.push({ language, sourcePath: posixPath, spec: match[1].trim(), kind: 'import', line });
    }
  }
  return rows;
}

function parseGoImports(filePath, text) {
  const rows = [];
  const single = /^\s*import\s+(?:[\w$]+\s+)?["]([^"]+)["]\s*$/gm;
  let match;
  while ((match = single.exec(text)) !== null) {
    rows.push({ language: 'go', sourcePath: filePath, spec: match[1], kind: 'import', line: countLineAt(text, match.index) + 1 });
  }
  const blockRe = /import\s*\(\s*([\s\S]*?)\s*\)/g;
  while ((match = blockRe.exec(text)) !== null) {
    const inner = match[1];
    const lineBase = countLineAt(text, match.index);
    const lineRe = /^\s*(?:[\w$]+\s+)?["]([^"]+)["]\s*$/gm;
    let innerMatch;
    while ((innerMatch = lineRe.exec(inner)) !== null) {
      const line = lineBase + 1 + countLineAt(inner, innerMatch.index);
      rows.push({ language: 'go', sourcePath: filePath, spec: innerMatch[1], kind: 'import', line });
    }
  }
  return rows;
}

function countLineAt(text, index) {
  const before = text.slice(0, index);
  const matches = before.match(/\n/g);
  return matches ? matches.length : 0;
}

function resolveInternal(row, fileIndex, tsAliases) {
  const { sourcePath, spec, language } = row;

  if (language === 'javascript' || language === 'typescript') {
    if (spec.startsWith('.')) {
      const target = resolveRelFile(sourcePath, spec, fileIndex);
      return target ? { path: target.path, confidence: 'high', resolution: target.resolution } : null;
    }
    // tsconfig/jsconfig paths 别名解析：按前缀最长匹配，逐个 target 依次尝试。
    for (const candidate of resolveAliasCandidates(spec, tsAliases)) {
      const target = resolveFromDir(candidate.baseDir, `./${candidate.path}`, fileIndex);
      if (target) {
        return { path: target.path, confidence: 'medium', resolution: `tsconfig paths: ${candidate.pattern}` };
      }
    }
    return null;
  }

  if (language === 'python') {
    if (spec.startsWith('.')) {
      const target = resolvePythonRelative(sourcePath, spec, fileIndex);
      return target ? { path: target, confidence: 'high', resolution: 'relative python import' } : null;
    }
    const top = spec.split('.')[0];
    const initCandidates = [`${top}/__init__.py`, `src/${top}/__init__.py`];
    for (const candidate of initCandidates) {
      if (fileIndex.has(candidate)) return { path: candidate, confidence: 'high', resolution: 'python package' };
    }
    // 没有 __init__.py 的命名空间包：从 src 布局解析 `myapp.app` -> `src/myapp/app.py`
    const dottedAsPath = `${spec.replace(/\./g, '/')}.py`;
    for (const candidate of [dottedAsPath, `src/${dottedAsPath}`]) {
      if (fileIndex.has(candidate)) return { path: candidate, confidence: 'medium', resolution: 'python namespace package' };
    }
    return null;
  }

  if (language === 'go') {
    const goMod = [...fileIndex.values()].find((f) => /^go\.mod$/.test(f.path) || f.path.endsWith('/go.mod'));
    const modText = goMod ? textOf(goMod) : null;
    let moduleName = '';
    if (modText) {
      const m = modText.match(/^\s*module\s+([^\s]+)/m);
      moduleName = m ? m[1] : '';
    }
    if (moduleName && (spec === moduleName || spec.startsWith(`${moduleName}/`))) {
      const rel = spec.slice(moduleName.length).replace(/^\/+/, '');
      let target = fileIndex.has(rel) ? rel : fileIndex.has(`${rel}.go`) ? `${rel}.go` : null;
      if (!target) {
        // 导入路径通常指向 Go package 目录；选择该目录内首个 .go 文件作为内部目标。
        const members = [...fileIndex.keys()]
          .filter((p) => p.startsWith(`${rel}/`) && p.endsWith('.go'))
          .sort();
        if (members.length > 0) target = members[0];
      }
      if (target) return { path: target, confidence: 'high', resolution: 'go module import' };
    }
    if (spec.startsWith('.')) {
      const target = resolveRelFile(sourcePath, spec, fileIndex, ['.go']);
      return target ? { path: target.path, confidence: 'high', resolution: target.resolution } : null;
    }
    return null;
  }

  return null;
}

function resolveRelFile(sourcePath, spec, fileIndex, forceExtensions) {
  const sourceDir = path.posix.dirname(sourcePath) || '.';
  return resolveFromDir(sourceDir, spec, fileIndex, forceExtensions);
}

function resolveFromDir(baseDir, relPath, fileIndex, forceExtensions) {
  const normalized = normalizeRelPosix(path.posix.join(baseDir || '.', relPath));
  const extensions = forceExtensions || JS_EXTENSIONS;
  for (const ext of extensions) {
    const candidatePath = normalizeRelPosix(`${normalized}${ext}`);
    if (fileIndex.has(candidatePath)) {
      return { path: candidatePath, resolution: `relative import resolved to ${candidatePath}` };
    }
  }
  return null;
}

function normalizeRelPosix(value) {
  const parts = String(value).replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

function resolvePythonRelative(sourcePath, spec, fileIndex) {
  const sourceDir = path.posix.dirname(sourcePath);
  let base = sourceDir;
  let module = spec;
  const levels = spec.match(/^\.+/)?.[0]?.length || 0;
  if (levels > 1) {
    for (let i = 1; i < levels; i += 1) {
      base = path.posix.dirname(base) || '.';
    }
    module = spec.slice(levels);
  } else if (levels === 1) {
    module = spec.slice(1);
    if (!module) {
      const init = path.posix.join(sourceDir, '__init__.py');
      return fileIndex.has(init) ? init : null;
    }
  }

  const test1 = path.posix.join(base, `${module.replace(/\./g, '/')}.py`);
  const test2 = path.posix.join(base, module.replace(/\./g, '/'), '__init__.py');
  if (fileIndex.has(test1)) return test1;
  if (fileIndex.has(test2)) return test2;
  return null;
}

function loadTsAliases(files) {
  const tsconfigs = files.filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f.path) || /(^|\/)jsconfig[^/]*\.json$/.test(f.path));
  if (tsconfigs.length === 0) return [];
  const fileIndex = new Map(files.map((f) => [f.path, f]));
  const configs = [];
  for (const file of tsconfigs) {
    const merged = readTsConfigWithExtends(file.path, fileIndex, new Set(), 0);
    if (!merged) continue;
    configs.push(buildAliasConfig(file.path, merged));
  }
  return configs;
}

/**
 * 读取 tsconfig 并沿 `extends` 链合并 compilerOptions（子配置优先，最多 5 层）。
 * 支持带注释的 JSONC；损坏的配置不视为致命错误。
 */
function readTsConfigWithExtends(configPath, fileIndex, visited, depth) {
  if (depth > 5 || visited.has(configPath)) return null;
  visited.add(configPath);
  const file = fileIndex.get(configPath);
  const text = file ? textOf(file) : null;
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }

  let merged = { compilerOptions: {} };
  const extendsValue = data.extends;
  if (extendsValue) {
    const parentPath = resolveExtendsPath(configPath, extendsValue);
    if (parentPath) {
      const parent = readTsConfigWithExtends(parentPath, fileIndex, visited, depth + 1);
      if (parent) merged = parent;
    }
    // 包名形式的 extends（如 @tsconfig/node18）在零依赖只读模式下无法解析，忽略。
  }

  const compilerOptions = { ...(merged.compilerOptions || {}), ...(data.compilerOptions || {}) };
  // paths 合并：子配置的同名 pattern 覆盖父配置，父配置独有 pattern 保留。
  const paths = { ...(merged.compilerOptions?.paths || {}), ...(data.compilerOptions?.paths || {}) };
  if (Object.keys(paths).length > 0) compilerOptions.paths = paths;
  return { compilerOptions };
}

function resolveExtendsPath(configPath, extendsValue) {
  const value = Array.isArray(extendsValue) ? extendsValue[0] : extendsValue;
  if (typeof value !== 'string' || value === '') return null;
  // 只支持相对路径 extends。
  if (!value.startsWith('./') && !value.startsWith('../')) return null;
  const dir = path.posix.dirname(configPath);
  let candidate = path.posix.normalize(path.posix.join(dir, value));
  if (!candidate.endsWith('.json')) candidate = `${candidate}.json`;
  return candidate;
}

function buildAliasConfig(configPath, merged) {
  const compilerOptions = merged.compilerOptions || {};
  const tsconfigDir = path.posix.dirname(configPath) || '.';
  const rawBaseUrl = compilerOptions.baseUrl || '.';
  // TypeScript 规则：baseUrl 相对于 tsconfig 文件所在目录。
  const baseDir = normalizeRelPosix(path.posix.join(tsconfigDir, rawBaseUrl));
  const paths = compilerOptions.paths || {};
  const mappings = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    // v0.2：一个 pattern 可声明多个 target，按声明顺序依次尝试。
    const targetList = Array.isArray(targets) ? targets : [targets];
    for (const target of targetList) {
      if (!target) continue;
      mappings.push({
        pattern,
        prefix: pattern.replace(/\*$/, ''),
        target: String(target).replace(/\*$/, ''),
        baseDir,
      });
    }
  }
  return { dir: tsconfigDir, baseDir, mappings };
}

/**
 * 生成别名解析候选：路径别名按前缀长度降序，附加保守的 baseUrl 裸模块名候选。
 */
function resolveAliasCandidates(spec, configs) {
  const out = [];
  for (const config of configs) {
    const mappings = [...config.mappings]
      .filter((m) => m.prefix && spec.startsWith(m.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    for (const mapping of mappings) {
      const sub = spec.slice(mapping.prefix.length);
      out.push({ baseDir: mapping.baseDir, path: `${mapping.target}${sub}`, pattern: mapping.pattern });
    }
    // baseUrl 裸模块名解析（保守启用：仅匹配首段没有路径分隔符的 spec）。
    if (!spec.includes('/') && config.baseDir && config.baseDir !== '.') {
      out.push({ baseDir: config.baseDir, path: spec, pattern: `baseUrl:${config.baseDir}` });
    }
  }
  return out;
}

function externalPackageName(spec, language) {
  if (!spec) return null;
  if (language === 'go') return spec;
  if (language === 'python') return spec.split('.')[0];
  if (language === 'java' || language === 'kotlin') return spec;
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.slice(0, 2).join('/');
  }
  return spec.split('/')[0];
}

function lookupPackageVersion(spec, fileIndex) {
  const packageName = externalPackageName(spec, null);
  const packageJson = fileIndex.get('package.json');
  if (packageJson) {
    try {
      const data = JSON.parse(textOf(packageJson) || 'null');
      const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}), ...(data.peerDependencies || {}) };
      return deps[packageName] ?? null;
    } catch {
      // fall through
    }
  }
  const goMod = fileIndex.get('go.mod');
  if (goMod) {
    const text = textOf(goMod) || '';
    const escape = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^\\s*${escape}\\s+(v[^\\s]+)`, 'm'));
    if (match) return match[1];
  }
  return null;
}

function mergeInternal(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.source} -> ${row.target} (${row.kind})`;
    if (!groups.has(key)) {
      groups.set(key, { ...row, locations: [{ line: row.line, spec: row.spec }] });
    } else {
      const g = groups.get(key);
      g.locations.push({ line: row.line, spec: row.spec });
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
    .map((g) => ({ ...g, line: g.locations[0]?.line ?? g.line }));
}

function dedupeExternal(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.source || ''} -> ${row.package || row.spec || ''} (${row.kind || 'none'})`;
    if (!groups.has(key)) groups.set(key, { ...row, locations: [{ line: row.line, spec: row.spec }] });
    else groups.get(key).locations.push({ line: row.line, spec: row.spec });
  }
  return [...groups.values()]
    .sort((a, b) => (a.source || '').localeCompare(b.source || '') || (a.package || '').localeCompare(b.package || ''))
    .map((g) => ({ ...g, line: g.locations[0]?.line ?? g.line }));
}

function extractManifestDependencies(files) {
  const out = [];
  const packageJson = files.find((f) => f.path === 'package.json');
  if (packageJson) {
    const data = tryJson(textOf(packageJson));
    if (data) {
      const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}) };
      for (const [name, version] of Object.entries(deps)) {
        out.push({ source: 'package.json', package: name, version: String(version), spec: name, line: null, kind: 'manifest', confidence: 'high' });
      }
    }
  }

  const goMod = files.find((f) => f.path === 'go.mod');
  if (goMod) {
    const text = textOf(goMod) || '';
    for (const line of text.split(/\r?\n/)) {
      // 单行 require module version
      const single = line.match(/^\s*require\s+([^\s]+)\s+([^\s]+)/);
      if (single) {
        out.push({ source: 'go.mod', package: single[1], version: single[2], spec: single[1], line: null, kind: 'manifest', confidence: 'high' });
      }
    }
    // require ( ... ) 块
    const blockRe = /^require\s*\(\s*([\s\S]*?)^\s*\)\s*$/gm;
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      for (const line of m[1].split(/\r?\n/)) {
        const single = line.match(/^\s*([^\s]+)\s+([^\s/]+)/);
        if (single) out.push({ source: 'go.mod', package: single[1], version: single[2], spec: single[1], line: null, kind: 'manifest', confidence: 'high' });
      }
    }
  }

  const pyproject = files.find((f) => f.path === 'pyproject.toml');
  if (pyproject) {
    const text = textOf(pyproject) || '';
    // 简化版：只解析 [project] 段内的 dependencies = [...] 列表。
    const projectSection = text.match(/\[project\][\s\S]*?(?=\n\[|$)/);
    if (projectSection) {
      const list = projectSection[0].match(/dependencies\s*=\s*\[([\s\S]*?)\n\s*\]/);
      if (list) {
        for (const item of list[1].split(/\s*,\s*/)) {
          const trimmed = item.trim();
          const match = trimmed.match(/^["']?([A-Za-z0-9_.-]+(?:\[[^\]]+\])?)["']?\s*([<>=~!^][^"']*)?["']?$/);
          if (match) {
            out.push({
              source: 'pyproject.toml',
              package: match[1],
              version: match[2] ? match[2].trim() : null,
              spec: trimmed.replace(/^["']|["']$/g, ''),
              line: null,
              kind: 'manifest',
              confidence: 'high',
            });
          }
        }
      }
    }
  }
  return out;
}

function tryJson(text) {
  try {
    return JSON.parse(text || 'null');
  } catch {
    return null;
  }
}

/**
 * 轻量 JSONC 处理：去掉 // 与 /* *​/ 注释，保留字符串内容。
 */
function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
