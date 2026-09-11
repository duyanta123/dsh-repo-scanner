# dsh-repo-scanner

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c1d95)](https://github.com/topics/dsh-plugin)
[![CI](https://github.com/duyanta123/dsh-repo-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/duyanta123/dsh-repo-scanner/actions/workflows/ci.yml)
[![npm](https://img.shields.io/badge/npm-dsh--repo--scanner-blue)](https://www.npmjs.com/package/dsh-repo-scanner)
[![version](https://img.shields.io/badge/version-0.1.2-green)](CHANGELOG.md)

面向 DeepSeek Harness 分析型插件的统一、可复现、只读的代码库事实扫描内核（npm 包名与仓库名一致：`dsh-repo-scanner`）。

只读：不修改目标仓库，不安装依赖，不执行项目代码。

## 定位

dsh-repo-scanner 是共享内核：把「仓库 → 结构化事实」这一步做成单一实现，供分析型插件复用，服务对象为 `arch-doc`、`dsh-refactor-insight`、`dsh-test-insight`（已发布）与 `dsh-change-impact`（规划中）。

它回答：
- 这是什么项目（语言 / 框架 / 仓库类型）？
- 有哪些文件、模块、符号、入口点？
- 内外部依赖关系如何，是否存在依赖环？
- Git 变更涉及哪些文件与模块（只读查询）？
- 变更影响面、测试↔源码映射、文档过期引用（事实 API）？

边界：只读内核，不做分析结论（那是上层插件的事）；输出 `schema_version` / `analysis_schema` 与 DSH 宿主版本独立，宿主升级不改变 schema。

## 安装

作为 DSH 插件（本包按 DSH bundle 规范打包，`package.json` 声明 `dsh.bundle.patch`，安装后自动注册 `repo-scanner-runbook` 技能）：

```sh
dsh plugin --profile web add "github:duyanta123/dsh-repo-scanner#v0.1.2"
```

或从 npm 安装（作为库或独立 CLI 使用）：

```sh
npm install dsh-repo-scanner
```

兼容性分层：库接口和 CLI 独立运行支持 Node.js >= 18（现有 Node 18/20/22 CI 是独立扫描器回归矩阵）；作为 DSH 0.1.5-rc.2 宿主运行要求 Node.js >= 22.19。可运行 `npm run test:compat` 完成临时 profile 的安装、配置 dump 与启动 smoke test。

安装后重启 `dsh --profile web`，技能即可被发现；技能只在需要时加载 runbook，扫描本身通过 shell 调用 CLI 完成。上层插件以库形式依赖本包时，经 exports 子路径 `dsh-repo-scanner/scanner` 引入扫描内核。

## 快速开始

### 1. 作为独立 CLI 使用

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

### 2. 作为库依赖（上层插件）

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

### 3. 事实 API（分析型插件专用）

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

## CLI 参数

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

## 输出

```json
{
  "schema_version": "1.0",
  "analysis_schema": { "name": "dsh-analysis-schema", "version": "1.0" },
  "tool": { "name": "dsh-repo-scanner", "version": "0.1.2" },
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

完整字段说明见 [docs/output-schema.md](docs/output-schema.md)。

## 安全红线

- 不写入目标仓库；不做 checkout/reset/clean。
- 不安装依赖、不执行目标项目代码或脚本。
- 路径规范化后拒绝越界；默认不跟随符号链接。
- 不 spawn 子进程获取文件或 Git 事实（由可执行安全审计测试保障）。
- 只把能解析到仓库内部的导入归为 internal；动态 import/require 记入 `risks`。
- 输出对 token/密码/连接串/JWT 自动脱敏。

## 与 arch-doc / dsh-refactor-insight 的关系

两个插件目前都各自带有 `arch-profile.mjs`。本包提取其扫描逻辑，可通过 npm dependency 或 CLI 被它们复用；迁移顺序与字段映射见 [docs/migration-guide.md](docs/migration-guide.md)（该迁移为规划中事项，尚未执行）。

## 文档

- [docs/output-schema.md](docs/output-schema.md) — 输出 JSON 契约（`schema_version 1.0` 全字段表）
- [docs/scanning-rules.md](docs/scanning-rules.md) — 扫描规则（目录安全、语言识别、模块识别、依赖解析、可插拔解析器、缓存、性能预算、安全审计）
- [docs/migration-guide.md](docs/migration-guide.md) — 分析型插件迁移到共享内核的规划
- [examples/](examples/README.md) — 输出示例
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
- [PLUGIN-MAINTENANCE.md](PLUGIN-MAINTENANCE.md) — 本仓维护规则

## License

[MIT](./LICENSE)
