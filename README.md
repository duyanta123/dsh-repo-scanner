# dsh-repo-scanner

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c1d95)](https://github.com/topics/dsh-plugin)
[![CI](https://github.com/duyanta123/dsh-repo-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/duyanta123/dsh-repo-scanner/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.1.0-green)](CHANGELOG.md)

面向 DeepSeek Harness 分析型插件（`arch-doc`、`dsh-refactor-insight`、`dsh-change-impact`、`dsh-test-insight`）的统一、可复现、只读的代码库事实扫描内核。

只读：不修改目标仓库，不安装依赖，不执行项目代码。

## 作为 DSH 插件安装

本包按 DSH bundle 规范打包（`package.json` 声明 `dsh.bundle.patch`），安装后自动注册 `repo-scanner-runbook` 技能：

```sh
dsh plugin --profile web add "github:duyanta123/dsh-repo-scanner#main"
```

安装后重启 `dsh --profile web`，技能即可被发现；技能只在需要时加载 runbook，扫描本身通过 shell 调用 CLI 完成。上层插件（dsh-change-impact / dsh-test-insight 等）以库形式依赖本包时，经 exports 子路径 `dsh-repo-scanner/scanner` 引入扫描内核。

## 环境与兼容性

- 库接口和 CLI 独立运行支持 Node.js >= 18；现有 Node 18/20/22 CI 是独立扫描器回归矩阵。
- 作为 DSH 0.1.2-rc.1 宿主运行要求 Node.js >= 22.12。可运行 `npm run test:compat` 完成临时 profile 的安装、配置 dump 与启动 smoke test。
- 输出 `schema_version` / `analysis_schema` 与 DSH 宿主版本独立，本次宿主升级不会改变 schema。

## 快速开始

```bash
node bin/repo-scanner.mjs <repo_path> --probe
node bin/repo-scanner.mjs <repo_path> --files
node bin/repo-scanner.mjs <repo_path> --scan
node bin/repo-scanner.mjs <repo_path> --deps
node bin/repo-scanner.mjs <repo_path> --entry
node bin/repo-scanner.mjs <repo_path> --symbols
node bin/repo-scanner.mjs <repo_path> --graphs
node bin/repo-scanner.mjs <repo_path> --git --diff-text-file diff.txt
node bin/repo-scanner.mjs <repo_path> --all --json
```

库接口：

```js
import { scanRepository } from 'dsh-repo-scanner/scanner';

const report = await scanRepository({
  repoPath: '.',
  modes: ['probe', 'modules', 'dependencies', 'entries', 'symbols', 'graphs', 'git'],
  maxDepth: 3,
  cache: true,                 // 增量扫描缓存
  parsers: ['heuristic'],      // 可插拔解析器（tree-sitter 为可选依赖）
  symbolQuery: { name: 'auth' }, // 符号查询
  git: { diffText },
});
```

### 事实 API

```js
import {
  getChangeImpactFacts, // 变更影响：反向依赖传播 + 受影响模块/符号
  getTestInsightFacts,  // 测试洞察：测试↔源码映射 + 模块覆盖
  getDocSyncFacts,      // 文档同步：文档引用 + 过期引用
} from 'dsh-repo-scanner/scanner';

const impact = await getChangeImpactFacts({
  repoPath: '.',
  git: { statusText }, // 或 diffText / changedFiles
});
```

## 输出示例

```json
{
  "schema_version": "1.0",
  "analysis_schema": { "name": "dsh-analysis-schema", "version": "1.0" },
  "tool": { "name": "dsh-repo-scanner", "version": "0.1.0" },
  "input": { "repo_path": ".", "resolved_path": "C:/work/app", "options": {} },
  "limits": { "max_depth": 3, "max_files": 2000, "max_file_bytes": 256000, "truncated": false, "warnings": [] },
  "project": {},
  "files": [],
  "modules": [],
  "dependencies": { "internal": [], "external": [] },
  "entry_points": [],
  "run_methods": [],
  "symbols": [],
  "graphs": null,
  "risks": [],
  "errors": [],
  "performance": null,
  "git": null
}
```

完整字段说明见 `docs/output-schema.md`；扫描规则见 `docs/scanning-rules.md`。

## 参数与退出码

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--max-depth N` | 3 | 最大目录深度 |
| `--max-files N` | 2000 | 最大文件数 |
| `--max-file-bytes N` | 256000 | 单文件内容读取上限 |
| `--include-dirs a,b` | 空 | 只扫描这些目录 |
| `--exclude-dirs a,b` | 内置默认 | 追加排除目录 |
| `--language LANG` | 空 | 语言过滤 |
| `--format json\|jsonl` | json | 输出格式 |
| `--hash` | 关 | 计算文件 sha256（按原始字节） |
| `--strict` | 关 | 存在错误或警告时非零退出 |
| `--follow-symlinks` | 关 | 跟随符号链接（目标必须在仓库内） |
| `--cache` / `--cache-dir DIR` | 关 | 增量扫描缓存（只写临时目录） |
| `--parsers a,b` | heuristic | 符号解析器链（tree-sitter 为可选依赖，缺失自动回退） |
| `--symbol-name/file/module` | 空 | 符号查询过滤 |
| `--perf-budget-ms N` | 60000 | 性能预算（0 关闭；超限写 warning） |

退出码：`0` 成功；`1` 存在错误，或 `--strict` 下存在警告；`2` 参数错误或仓库路径无效；`3` 输出失败或契约错误。

## 安全红线

- 不写入目标仓库；不做 checkout/reset/clean。
- 不安装依赖、不执行目标项目代码或脚本。
- 路径规范化后拒绝越界；默认不跟随符号链接。
- 不 spawn 子进程获取文件或 Git 事实（由可执行安全审计测试保障）。
- 只把能解析到仓库内部的导入归为 internal；动态 import/require 记入 `risks`。
- 输出对 token/密码/连接串/JWT 自动脱敏。

## 与 arch-doc / dsh-refactor-insight 的关系

两个插件都有各自的 `arch-profile.mjs`。本包提取其扫描逻辑，通过 npm dependency 或 CLI 被它们复用。迁移顺序与字段映射见 `docs/migration-guide.md`。

## 开发

```bash
npm test    # 功能测试 + 安全审计测试
npm run test:compat    # DSH 0.1.2-rc.1 宿主兼容性门禁
npm run check
```

Node >=18。
