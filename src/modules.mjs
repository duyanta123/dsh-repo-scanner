import { detectLanguage } from './filesystem.mjs';

/**
 * 模块识别思路：按语言约定和目录布局分组，不推断模块职责。
 * 输出只包含路径、语言、文件数、关键文件和证据。
 */
export function scanModules(files, context = {}) {
  const project = context.project || null;
  const language = context.language || project?.language || null;
  const repoType = context.repoType || project?.repo_type || 'unknown';
  const modules = [];

  const sourceFiles = files.filter((f) => f.kind === 'source' && f.language);

  if (repoType === 'monorepo') {
    modules.push(...scanMonorepoModules(files, sourceFiles));
  }

  const perLanguageModules = scanLanguageModules(sourceFiles, language, repoType);
  modules.push(...perLanguageModules);

  const unassigned = getUnassignedSourceFiles(sourceFiles, modules);
  if (unassigned.length > 0) {
    modules.push(makeModule('root', '.', language || detectLanguage(unassigned[0].path) || null, unassigned, ['toplevel source files']));
  }

  return dedupeModules(modules);
}

function scanMonorepoModules(files, sourceFiles) {
  const out = [];
  const firstSegments = new Set(sourceFiles.map((f) => f.path.split('/')[0]));
  if (firstSegments.has('packages') || firstSegments.has('apps')) {
    for (const root of ['packages', 'apps']) {
      const sub = sourceFiles
        .filter((f) => f.path.startsWith(`${root}/`))
        .map((f) => ({ ...f, _path: f.path.slice(root.length + 1) }));
      const packageNames = new Set(sub.map((f) => f._path.split('/')[0]).filter(Boolean));
      for (const name of packageNames) {
        const members = sub.filter((f) => f._path.startsWith(`${name}/`) || f._path === name);
        if (members.length === 0) continue;
        out.push(makeModule(name, `${root}/${name}`, dominantLanguage(members), members.map(({ _path, ...f }) => f), [`${root}/* directory`]));
      }
    }
  }

  // 顶层 package.json 子目录：每个子目录如果有自己的 package.json 且不在 packages/apps 中。
  for (const f of files) {
    if (!/<internal>/i.test(f.path) && /(^|\/)package\.json$/.test(f.path)) {
      const dir = f.path.replace(/\/?package\.json$/, '');
      if (!dir) continue;
      const first = dir.split('/')[0];
      if (first === 'packages' || first === 'apps') continue;
      const members = sourceFiles.filter((s) => s.path.startsWith(`${dir}/`));
      if (members.length > 0 && !out.some((m) => m.path === dir)) {
        out.push(makeModule(dir.split('/').pop() || dir, dir, dominantLanguage(members), members, [`package.json in ${dir}`]));
      }
    }
  }
  return out;
}

function scanLanguageModules(sourceFiles, language, repoType) {
  const out = [];
  if (language === 'typescript' || language === 'javascript') {
    out.push(...scanJsTsModules(sourceFiles));
  } else if (language === 'python') {
    out.push(...scanPythonModules(sourceFiles));
  } else if (language === 'go') {
    out.push(...scanGoModules(sourceFiles));
  } else if (language === 'java' || language === 'kotlin') {
    out.push(...scanJavaModules(sourceFiles));
  }

  // 通用目录约定回退，仅当语言专属规则没有产出时使用。
  if (out.length === 0) out.push(...scanGenericModules(sourceFiles));
  return out;
}

function scanJsTsModules(sourceFiles) {
  const out = [];
  for (const root of ['src', 'lib']) {
    const members = sourceFiles.filter((f) => f.path.startsWith(`${root}/`));
    const rootDepth = root.split('/').length;
    // 只把 `src/<目录>/*` 视为模块目录；`src/index.js` 这类文件不属于任何子模块。
    const subDirs = new Set(
      members
        .filter((f) => f.path.split('/').length > rootDepth + 1)
        .map((f) => f.path.split('/')[rootDepth])
        .filter(Boolean),
    );
    for (const name of subDirs) {
      const modMembers = members.filter((f) => f.path.startsWith(`${root}/${name}/`) || f.path === `${root}/${name}`);
      if (modMembers.length === 0) continue;
      out.push(makeModule(name, `${root}/${name}`, dominantLanguage(modMembers), modMembers, [`${root}/* directory`]));
    }
  }
  // src 下扁平文件归入 `src` 模块。
  const srcFlat = sourceFiles.filter((f) => f.path.startsWith('src/') && f.path.split('/').length === 2);
  if (srcFlat.length > 0 && !out.some((m) => m.path === 'src')) {
    out.push(makeModule('src', 'src', dominantLanguage(srcFlat), srcFlat, ['flat src directory']));
  }
  return out;
}

function scanPythonModules(sourceFiles) {
  const out = [];
  const packageDirs = new Set();
  for (const f of sourceFiles) {
    const parts = f.path.split('/');
    // src/<pkg>/...
    if (parts[0] === 'src' && parts.length >= 3 && !parts[1].includes('.')) {
      packageDirs.add(`src/${parts[1]}`);
    }
    // 顶层 Python package：目录下必须还有至少一层文件。
    if (parts.length >= 3 && !parts[0].includes('.')) {
      packageDirs.add(parts[0]);
    }
  }
  for (const pkg of packageDirs) {
    if (pkg.includes('.')) continue;
    const members = sourceFiles.filter((f) => f.path === pkg || f.path.startsWith(`${pkg}/`));
    if (members.length === 0) continue;
    const name = pkg.split('/').length > 1 ? pkg.split('/')[1] : pkg;
    out.push(makeModule(name, pkg, 'python', members, ['python package directory']));
  }
  return out;
}

function scanGoModules(sourceFiles) {
  const out = [];
  for (const root of ['cmd', 'internal', 'pkg']) {
    const rootFiles = sourceFiles.filter((f) => f.path.startsWith(`${root}/`));
    const rootDepth = root.split('/').length;
    const subDirs = new Set(
      rootFiles
        .filter((f) => f.path.split('/').length > rootDepth + 1)
        .map((f) => f.path.split('/')[rootDepth])
        .filter(Boolean),
    );
    for (const name of subDirs) {
      const members = rootFiles.filter((f) => f.path.startsWith(`${root}/${name}/`) || f.path === `${root}/${name}`);
      if (members.length === 0) continue;
      out.push(makeModule(name, `${root}/${name}`, 'go', members, [`${root}/* directory`]));
    }
  }
  return out;
}

function scanJavaModules(sourceFiles) {
  const out = [];
  for (const root of ['src/main/java', 'src/main/kotlin']) {
    const rootFiles = sourceFiles.filter((f) => f.path.startsWith(`${root}/`));
    // Java/Kotlin 包路径较深；按前两级 package 目录聚合为模块。
    const groups = new Map();
    for (const f of rootFiles) {
      const parts = f.path.slice(root.length + 1).split('/');
      parts.pop(); // 去掉文件名
      if (parts.length === 0) continue;
      const key = parts.slice(0, Math.min(2, parts.length)).join('/');
      const modulePath = `${root}/${key}`;
      groups.set(modulePath, [...(groups.get(modulePath) || []), f]);
    }
    for (const [modulePath, members] of groups) {
      const name = modulePath.split('/').slice(2).join('.');
      out.push(makeModule(name, modulePath, languageOfMembers(members), members, [`${root} package directory`]));
    }
  }
  return out;
}

function scanGenericModules(sourceFiles) {
  const out = [];
  for (const root of ['src', 'app', 'lib', 'packages']) {
    const rootFiles = sourceFiles.filter((f) => f.path.startsWith(`${root}/`));
    const subNames = new Set(rootFiles.map((f) => f.path.slice(root.length + 1).split('/')[0]).filter(Boolean));
    for (const name of subNames) {
      const members = rootFiles.filter((f) => f.path.startsWith(`${root}/${name}/`) || f.path === `${root}/${name}`);
      if (members.length === 0) continue;
      out.push(makeModule(name, `${root}/${name}`, dominantLanguage(members), members, [`${root}/* directory`]));
    }
  }
  return out;
}

function dominantLanguage(files) {
  const counts = new Map();
  for (const f of files) {
    if (f.language) counts.set(f.language, (counts.get(f.language) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

function languageOfMembers(files) {
  return dominantLanguage(files);
}

function getUnassignedSourceFiles(sourceFiles, modules) {
  const assigned = new Set();
  for (const mod of modules) {
    for (const path of mod.file_paths || []) assigned.add(path);
  }
  return sourceFiles.filter((f) => !assigned.has(f.path));
}

function makeModule(name, modulePath, language, files, evidence) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const keyFiles = pickKeyFiles(sorted).map((f) => f.path);
  return {
    name,
    path: modulePath.replace(/^\.\//, ''),
    language,
    file_count: sorted.length,
    file_paths: sorted.map((f) => f.path),
    key_files: keyFiles,
    evidence,
    confidence: 'high',
  };
}

function pickKeyFiles(files) {
  const scores = files.map((f) => {
    const base = f.path.split('/').pop().toLowerCase();
    let score = 1;
    if (/^(index|main|app|server|service|__init__)\./.test(base)) score += 10;
    if (/service|controller|repository|router|model|models|api/.test(base)) score += 2;
    return [f, score];
  });
  return scores.sort((a, b) => b[1] - a[1] || a[0].path.localeCompare(b[0].path)).slice(0, 5).map(([f]) => f);
}

function dedupeModules(modules) {
  const map = new Map();
  for (const mod of modules) {
    if (!mod || mod.file_count === 0) continue;
    const existing = map.get(mod.path);
    if (existing) {
      const paths = [...new Set([...existing.file_paths, ...mod.file_paths])].sort();
      existing.file_count = paths.length;
      existing.file_paths = paths;
      existing.key_files = pickKeyFiles(paths.map((p) => ({ path: p, language: existing.language }))).map((f) => f.path);
      continue;
    }
    map.set(mod.path, mod);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}