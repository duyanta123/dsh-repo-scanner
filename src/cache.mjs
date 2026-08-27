import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { toPosixPath } from './options.mjs';

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 100000;

/**
 * 增量扫描缓存（v0.2 / v1.0 大仓库增量索引）。
 *
 * 只写系统临时目录，绝不写入目标仓库。按 mtimeMs + size 判断文件是否
 * 失效；若调用方开启 --hash，还会校验 sha256。未命中的文件读盘后更新。
 */
export function getDefaultCacheDir() {
  return path.join(os.tmpdir(), 'dsh-repo-scanner-cache');
}

export function hashRepoKey({ repoPath, maxDepth, maxFiles, maxFileBytes, includeDirs, excludeDirs }) {
  const payload = JSON.stringify({
    repoPath,
    maxDepth,
    maxFiles,
    maxFileBytes,
    includeDirs,
    excludeDirs,
    version: CACHE_VERSION,
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

export async function createScanCache(options = {}) {
  const cacheDir = options.cacheDir || getDefaultCacheDir();
  const repoKey = hashRepoKey(options);
  const cacheFile = path.join(cacheDir, `${repoKey}.json`);
  const stats = { hits: 0, misses: 0, wrote_bytes: 0 };
  let entries = new Map();
  let dirty = false;

  async function load() {
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const raw = await fs.promises.readFile(cacheFile, 'utf8');
      const data = JSON.parse(raw);
      if (data?.version === CACHE_VERSION && data?.files && typeof data.files === 'object') {
        entries = new Map(Object.entries(data.files));
      }
    } catch {
      // 不存在或损坏时从空缓存开始，不影响扫描主流程。
      entries = new Map();
    }
  }

  function get(filePath) {
    return entries.get(toPosixPath(filePath)) || null;
  }

  function set(filePath, entry) {
    const key = toPosixPath(filePath);
    entries.set(key, entry);
    if (entries.size > MAX_CACHE_ENTRIES) {
      // 简单策略：删除最早插入的多余条目（JS Map 保序）。
      const excess = entries.size - MAX_CACHE_ENTRIES;
      let removed = 0;
      for (const k of entries.keys()) {
        if (removed >= excess) break;
        entries.delete(k);
        removed += 1;
      }
    }
    dirty = true;
  }

  async function save() {
    if (!dirty) return;
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const data = JSON.stringify({ version: CACHE_VERSION, repo: options.repoPath, files: Object.fromEntries(entries) });
      const tmpFile = `${cacheFile}.tmp`;
      await fs.promises.writeFile(tmpFile, data, 'utf8');
      stats.wrote_bytes = Buffer.byteLength(data, 'utf8');
      await fs.promises.rename(tmpFile, cacheFile);
      dirty = false;
    } catch {
      // 缓存写入失败不应导致扫描失败。
    }
  }

  return { cacheFile, load, get, set, save, stats, entries };
}