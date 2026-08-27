import path from 'node:path';
import { detectLanguage } from './filesystem.mjs';

const WEB_FRAMEWORK_HINTS = [
  ['express', 'Express'],
  ['fastapi', 'FastAPI'],
  ['flask', 'Flask'],
  ['django', 'Django'],
  ['spring', 'Spring Boot'],
  ['gin', 'Gin'],
  ['fiber', 'Fiber'],
  ['nest', 'NestJS'],
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['react', 'React'],
  ['vue', 'Vue'],
];

function readText(file) {
  return file?._text ?? null;
}

function parseJson(file) {
  try {
    return JSON.parse(readText(file) || 'null');
  } catch {
    return null;
  }
}

function getPackageJson(files) {
  const manifest = files.find((f) => f.path === 'package.json');
  if (!manifest) return null;
  return parseJson(manifest);
}

function getPyproject(files) {
  const manifest = files.find((f) => f.path === 'pyproject.toml');
  return manifest ? readText(manifest) : null;
}

function getGoMod(files) {
  const manifest = files.find((f) => f.path === 'go.mod');
  return manifest ? readText(manifest) : null;
}

function extractProjectName(goModText) {
  if (!goModText) return null;
  const match = goModText.match(/^\s*module\s+([^\s/]+)/im);
  return match ? match[1] : null;
}

function extractPyprojectValue(pyprojectText, key) {
  if (!pyprojectText) return null;
  const match = pyprojectText.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match ? match[1] : null;
}

function isMonorepo(files, packageJson, pyproject) {
  const evidence = [];
  if (packageJson?.workspaces) evidence.push('package.json#workspaces');
  if (files.some((f) => ['pnpm-workspace.yaml', 'lerna.json', 'rush.json'].includes(f.path))) {
    evidence.push(files.find((f) => ['pnpm-workspace.yaml', 'lerna.json', 'rush.json'].includes(f.path)).path);
  }
  const packageManifestCount = files.filter((f) => f.path === 'package.json' || /(^|\/)package\.json$/.test(f.path)).length;
  if (packageManifestCount > 1) evidence.push(`package.json x ${packageManifestCount}`);
  const dirs = new Set(files.map((f) => f.path.split('/')[0]));
  if (dirs.has('packages') || dirs.has('apps')) evidence.push('packages/apps directory layout');
  return evidence;
}

function isCliPackage(packageJson, files) {
  const evidence = [];
  if (packageJson?.bin) evidence.push('package.json#bin');
  if (files.some((f) => /^cli\.(js|ts|py|mjs|tsx)$/i.test(f.path.split('/').pop()))) evidence.push('cli.* entry file');
  if (files.some((f) => f.path.startsWith('cmd/') || f.path.startsWith('bin/'))) evidence.push('cmd/ or bin/ directory');
  return evidence;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isServiceRepo(files) {
  const evidence = [];
  const codeText = files
    .filter((f) => f.kind === 'source' || f.kind === 'test')
    .slice(0, 200)
    .map((f) => readText(f) || '')
    .join('\n');
  const hasDocker = files.some((f) => {
    const base = f.path.split('/').pop().toLowerCase();
    return base === 'dockerfile' || base.startsWith('dockerfile.') || /^docker-compose/i.test(base) || /^compose[^\/]*\.(yaml|yml)$/i.test(base);
  });
  if (hasDocker) evidence.push('Dockerfile/compose');
  const webHints = WEB_FRAMEWORK_HINTS.filter(([needle]) => {
    const wordRe = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i');
    return wordRe.test(codeText) || files.some((f) => wordRe.test(f.path));
  }).map(([, label]) => label);
  if (webHints.length > 0) evidence.push(`web framework: ${webHints.join(', ')}`);
  return evidence;
}

function detectRepoType(files, packageJson, monorepoEvidence, cliEvidence, serviceEvidence) {
  if (monorepoEvidence.length > 0) return { repo_type: 'monorepo', evidence: monorepoEvidence };
  if (cliEvidence.length > 0 && !packageJson?.main && !packageJson?.module && !packageJson?.exports) {
    return { repo_type: 'cli', evidence: cliEvidence };
  }
  if (serviceEvidence.length > 0) return { repo_type: 'service', evidence: serviceEvidence };
  if (packageJson && (packageJson.main || packageJson.module || packageJson.exports) && !packageJson.bin) {
    return { repo_type: 'library', evidence: ['package.json main/module/exports'] };
  }
  if (files.some((f) => f.path === 'pyproject.toml') || files.some((f) => f.path === 'setup.py')) {
    return { repo_type: 'library', evidence: ['python packaging manifest'] };
  }
  if (files.some((f) => f.path === 'go.mod')) {
    return { repo_type: 'library', evidence: ['go.mod'] };
  }
  return { repo_type: 'unknown', evidence: ['insufficient signals'] };
}

/**
 * 仓库探测：语言、仓库类型、技术栈、manifest 与统计。
 */
export function probeProject(files, context = {}) {
  const repoPath = context.repoPath || context.options?.repoPath || '.';
  const packageJson = getPackageJson(files);
  const pyproject = getPyproject(files);
  const goMod = getGoMod(files);
  const manifests = files.filter((f) => f.kind === 'manifest').map((f) => f.path).sort();

  const languageCounts = new Map();
  for (const file of files) {
    if (file.language) {
      languageCounts.set(file.language, (languageCounts.get(file.language) || 0) + 1);
    }
  }
  const primaryLanguage = [...languageCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  const languageEvidence = [...languageCounts.keys()].length > 1
    ? manifests.filter((m) => /^(package\.json|pyproject\.toml|go\.mod|pom\.xml)$/.test(m))
    : [];
  if (languageEvidence.length === 0 && primaryLanguage) {
    languageEvidence.push(`${primaryLanguage} source files`);
  }

  const monorepoEvidence = isMonorepo(files, packageJson, pyproject);
  const cliEvidence = isCliPackage(packageJson, files);
  const serviceEvidence = isServiceRepo(files);
  const repoType = detectRepoType(files, packageJson, monorepoEvidence, cliEvidence, serviceEvidence);

  const techStack = new Set();
  if (primaryLanguage) techStack.add(primaryLanguage);
  for (const [needle, label] of WEB_FRAMEWORK_HINTS) {
    if (files.some((f) => f.path.toLowerCase().includes(needle.toLowerCase()))) {
      techStack.add(label);
    }
  }
  if (files.some((f) => f.path === 'package.json')) techStack.add('npm');
  if (files.some((f) => f.path === 'pyproject.toml')) techStack.add('python');
  if (files.some((f) => f.path === 'go.mod')) techStack.add('go');

  const project = {
    name: packageJson?.name || extractProjectName(goMod) || extractPyprojectValue(pyproject, 'name') || repoPath.split(/[\\/]/).pop() || 'unknown',
    description: packageJson?.description || extractPyprojectValue(pyproject, 'description'),
    language: primaryLanguage,
    repo_type: repoType.repo_type,
    repo_type_evidence: repoType.evidence,
    tech_stack: [...techStack].sort(),
    manifest_files: manifests,
    // v0.2：API 契约与数据库迁移文件识别（只报告路径事实）。
    openapi_files: files.filter((f) => f.kind === 'openapi').map((f) => f.path).sort(),
    graphql_files: files.filter((f) => f.kind === 'graphql').map((f) => f.path).sort(),
    db_migration_files: files.filter((f) => f.kind === 'db_migration').map((f) => f.path).sort(),
    file_count: files.length,
    source_file_count: files.filter((f) => f.kind === 'source').length,
    confidence: primaryLanguage ? 'high' : 'medium',
  };

  // 语言证据至少保留一个可解释来源
  project.language_evidence = primaryLanguage
    ? files.filter((f) => f.language === primaryLanguage).slice(0, 5).map((f) => f.path)
    : [];

  return project;
}

export function getFileText(file) {
  return readText(file);
}