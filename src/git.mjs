import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toPosixPath } from './options.mjs';

function readTextSafe(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Git 只读事实层。不 spawn 子进程，不执行任何写操作。
 *
 * 变更信息可通过 `options.git.diffText` / `options.git.statusText` /
 * `options.git.changedFiles` 传入；若未提供，则只返回 HEAD 与分支等
 * 元数据，changed_files 返回 [] 并由 report 记录 warning。
 *
 * working_tree_clean：只读模式下无法直接枚举工作区差异，仅当调用方
 * 提供 statusText 时可判定（空输出 = 干净）；其余场景保持 null（事实
 * 为"不可判定"，不猜测）。
 */
export function inspectGit(repoPath, options = {}) {
  const provided = extractProvidedChangedFiles(options);
  const gitDir = findGitDir(repoPath);
  const gitOpts = options.git || {};
  const compare = {
    base: gitOpts.base ?? null,
    head: gitOpts.head ?? null,
  };

  if (!gitDir) {
    const warnings = provided.changed_files.length === 0 && !provided.hasInput
      ? [{ code: 'E_GIT_NOT_FOUND', message: 'no .git directory found; read-only git metadata unavailable' }]
      : [];
    return {
      available: false,
      head_ref: null,
      branch: null,
      head_sha: null,
      working_tree_clean: provided.workingTreeClean,
      changed_files: provided.changed_files,
      compare,
      warnings,
      method: provided.hasInput ? provided.method : 'none',
    };
  }

  const headInfo = readHeadInfo(gitDir);
  const warnings = [];
  const changedFiles = provided.changed_files;
  const method = provided.hasInput ? provided.method : 'read-only-gitdir';

  if (!provided.hasInput) {
    warnings.push({ code: 'E_GIT_DIFF_UNAVAILABLE', message: 'git diff text not provided; changed files unavailable in read-only mode' });
  }

  return {
    available: true,
    head_ref: headInfo.head_ref,
    branch: headInfo.branch,
    head_sha: headInfo.head_sha,
    working_tree_clean: provided.workingTreeClean,
    changed_files: changedFiles,
    compare,
    warnings,
    method,
  };
}

function extractProvidedChangedFiles(options) {
  if (!options || typeof options !== 'object' || !options.git) {
    return { changed_files: [], hasInput: false, method: null, workingTreeClean: null };
  }
  const gitOpts = options.git;
  if (gitOpts.changedFiles) {
    return { changed_files: normalizeChangedFiles(gitOpts.changedFiles), hasInput: true, method: 'provided-changed-files', workingTreeClean: null };
  }
  if (typeof gitOpts.statusText === 'string') {
    // 空字符串是合法输入：代表工作区干净。
    const parsed = parseGitStatusText(gitOpts.statusText);
    // working_tree_clean 基于未过滤的原始 status 判定：任何条目（含未跟踪文件）都视为不干净。
    const workingTreeClean = parsed.length === 0;
    const includeUntracked = gitOpts.includeUntracked !== false;
    const changed = includeUntracked ? parsed : parsed.filter((f) => f.status !== 'untracked');
    return { changed_files: changed, hasInput: true, method: 'provided-status-text', workingTreeClean };
  }
  if (typeof gitOpts.diffText === 'string') {
    return { changed_files: parseGitDiffText(gitOpts.diffText).changed_files, hasInput: true, method: 'provided-diff-text', workingTreeClean: null };
  }
  return { changed_files: [], hasInput: false, method: null, workingTreeClean: null };
}

function findGitDir(repoPath) {
  const direct = path.join(repoPath, '.git');
  try {
    const stat = fs.statSync(direct);
    if (stat.isDirectory()) return direct;
    if (stat.isFile()) {
      const content = readTextSafe(direct) || '';
      const match = content.match(/^gitdir:\s*(.+)\s*$/);
      if (match) {
        const resolved = path.resolve(repoPath, match[1]);
        if (fs.existsSync(resolved)) return resolved;
      }
      return direct;
    }
  } catch {
    // continue
  }
  return null;
}

function readHeadInfo(gitDir) {
  const headText = readTextSafe(path.join(gitDir, 'HEAD'));
  if (!headText) return { head_ref: null, branch: null, head_sha: null };
  const trimmed = headText.trim();
  const refMatch = trimmed.match(/^ref:\s*(.+)$/);
  if (refMatch) {
    const ref = refMatch[1].trim();
    const sha = readTextSafe(path.join(gitDir, ref))?.trim() || null;
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    return { head_ref: ref, branch, head_sha: sha };
  }
  if (/^[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { head_ref: null, branch: null, head_sha: trimmed.toLowerCase() };
  }
  return { head_ref: trimmed, branch: trimmed, head_sha: null };
}

/**
 * 解析 `git diff` 全文（或 `git diff --numstat` / `--name-status` 的常用子集）。
 */
export function parseGitDiffText(text) {
  const changedFiles = [];
  const warnings = [];
  if (typeof text !== 'string' || text.trim() === '') return { changed_files: changedFiles, warnings };

  const rawBlocks = String(text).replace(/\r\n/g, '\n').split(/^diff --git /m);
  for (const raw of rawBlocks) {
    if (!raw) continue;
    const block = `diff --git ${raw}`;
    const file = parseUnifiedDiffBlock(block);
    if (file) changedFiles.push(file);
  }

  if (changedFiles.length === 0) {
    warnings.push({ code: 'E_GIT_DIFF_PARSE_EMPTY', message: 'diff text did not contain any parseable diff --git blocks' });
  }
  return { changed_files: changedFiles, warnings };
}

/**
 * 解析 `git status --porcelain` / `git diff --name-status` 文本。
 */
export function parseGitStatusText(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const out = [];
  for (const rawLine of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (!rawLine.trim()) continue;
    let codeFull;
    let oldPath;
    let newPath;

    // `git diff --name-status -z` / 常见制表符分隔形式：R100\told\tnew
    const tabParts = rawLine.split('\t');
    if (tabParts.length >= 3 && /^[MADRCUTX?]{1,2}\d*$/.test(tabParts[0])) {
      codeFull = tabParts[0];
      oldPath = unquoteGitPath(tabParts[1]);
      newPath = unquoteGitPath(tabParts[2]);
    } else {
      const match = rawLine.match(/^([MADRCUTX?]{1,2}\d*)\s+(.*)$/);
      if (!match) continue;
      codeFull = match[1];
      const rest = match[2].trim();
      if (rest.includes(' -> ')) {
        const arrow = rest.indexOf(' -> ');
        oldPath = unquoteGitPath(rest.slice(0, arrow));
        newPath = unquoteGitPath(rest.slice(arrow + 4));
      } else if (/^[RC]/i.test(codeFull)) {
        const parts = rest.split(/\s+/);
        if (parts.length >= 2) {
          oldPath = unquoteGitPath(parts[0]);
          newPath = unquoteGitPath(parts.slice(1).join(' '));
        } else {
          oldPath = unquoteGitPath(rest);
          newPath = unquoteGitPath(rest);
        }
      } else {
        oldPath = unquoteGitPath(rest);
        newPath = unquoteGitPath(rest);
      }
    }

    const code = codeFull[0];
    let status;
    if (code === 'R') status = 'renamed';
    else if (code === 'C') status = 'copied';
    else if (code === '?') status = 'untracked';
    else status = mapStatusCode(codeFull);
    out.push({ status, old_path: oldPath, new_path: newPath, additions: 0, deletions: 0, hunks: [] });
  }
  return out;
}

function parseUnifiedDiffBlock(block) {
  const lines = block.split('\n');
  const file = {
    status: 'modified',
    old_path: null,
    new_path: null,
    additions: 0,
    deletions: 0,
    hunks: [],
    binary: false,
    lines_added: 0,
    lines_deleted: 0,
  };
  let oldHeader = false;
  let newHeader = false;
  let currentHunk = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') {
        file.old_path = p.replace(/^a\//, '');
        oldHeader = true;
      } else {
        oldHeader = true;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') {
        file.new_path = p.replace(/^b\//, '');
        newHeader = true;
      } else {
        newHeader = true;
      }
      continue;
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.old_path = line.slice('rename from '.length);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.new_path = line.slice('rename to '.length);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('copy from ')) {
      file.old_path = line.slice('copy from '.length);
      file.status = 'copied';
      continue;
    }
    if (line.startsWith('copy to ')) {
      file.new_path = line.slice('copy to '.length);
      file.status = 'copied';
      continue;
    }
    if (line.startsWith('Binary files')) {
      file.binary = true;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        currentHunk = {
          header: line,
          old_start: Number.parseInt(m[1], 10),
          old_count: m[2] != null ? Number.parseInt(m[2], 10) : 1,
          new_start: Number.parseInt(m[3], 10),
          new_count: m[4] != null ? Number.parseInt(m[4], 10) : 1,
          lines: [],
        };
        file.hunks.push(currentHunk);
      }
      continue;
    }
    if (currentHunk) {
      if (line.startsWith('+')) {
        file.additions += 1;
        currentHunk.lines.push(line);
      } else if (line.startsWith('-')) {
        file.deletions += 1;
        currentHunk.lines.push(line);
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push(line);
      } else if (line === '\\ No newline at end of file') {
        currentHunk.lines.push(line);
      }
    }
  }

  if (!file.new_path) file.new_path = file.old_path;
  if (!file.old_path) file.old_path = file.new_path;
  if (file.status === 'modified' && file.binary) file.status = 'binary';
  if (!file.old_path && !file.new_path) return null;
  file.lines_added = file.additions;
  file.lines_deleted = file.deletions;
  delete file.additions;
  delete file.deletions;
  return file;
}

function normalizeChangedFiles(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    status: item.status || 'modified',
    old_path: item.old_path ?? item.oldPath ?? null,
    new_path: item.new_path ?? item.newPath ?? null,
    additions: item.additions ?? item.lines_added ?? 0,
    deletions: item.deletions ?? item.lines_deleted ?? 0,
    hunks: item.hunks || [],
    binary: item.binary === true,
  }));
}

function mapStatusCode(code) {
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'M') return 'modified';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  if (code === 'T') return 'type_changed';
  if (code === 'U') return 'unknown';
  return 'unknown';
}

function unquoteGitPath(text) {
  if (text == null) return null;
  let p = String(text).trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1);
  }
  return p;
}

export function computeBlobHash(text) {
  return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0`).update(text, 'utf8').digest('hex');
}