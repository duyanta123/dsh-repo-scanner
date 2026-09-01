---
name: repo-scanner-runbook
description: 只读仓库事实扫描：输入一个代码库路径，确定性地提取仓库探测、文件索引、模块识别、依赖关系、入口点、符号定位与 Git 变更基线等硬事实（JSON 输出）。需要摸清陌生项目结构、提取模块依赖、定位函数符号、分析变更影响或为其他分析插件提供扫描事实时加载本技能。
---

# repo-scanner-runbook

只读仓库事实扫描器 runbook。扫描器不修改仓库、不安装依赖、不执行项目代码。

## 调用方式

```bash
# 基础用法
node bin/repo-scanner.mjs <repo_path> --probe
node bin/repo-scanner.mjs <repo_path> --files
node bin/repo-scanner.mjs <repo_path> --scan
node bin/repo-scanner.mjs <repo_path> --deps
node bin/repo-scanner.mjs <repo_path> --entry
node bin/repo-scanner.mjs <repo_path> --symbols
node bin/repo-scanner.mjs <repo_path> --graphs
node bin/repo-scanner.mjs <repo_path> --git --diff-text-file diff.txt
node bin/repo-scanner.mjs <repo_path> --all --json

# 常用组合
node bin/repo-scanner.mjs <repo_path> --symbols --symbol-name login      # 符号查询
node bin/repo-scanner.mjs <repo_path> --all --cache                      # 增量缓存
node bin/repo-scanner.mjs <repo_path> --all --perf-budget-ms 30000       # 性能预算
```

## 库接口

```js
import { scanRepository } from 'dsh-repo-scanner/scanner';

const report = await scanRepository({
  repoPath: '.',
  modes: ['probe', 'scan', 'deps', 'entry', 'symbols', 'graphs', 'git'],
  git: { diffText },
});

// 事实 API
import {
  getChangeImpactFacts,
  getTestInsightFacts,
  getDocSyncFacts,
} from 'dsh-repo-scanner/scanner';
```

## 输出字段

- `project`：语言、仓库类型、技术栈、manifest 文件、API 契约（openapi/graphql/db 迁移）与文件统计。
- `files`：文件路径（POSIX `/`）、kind、language、bytes、lines、可选 sha256（按原始字节）。
- `modules`：按目录约定识别的模块路径与关键文件，不推断职责。
- `dependencies.internal`：能解析到仓库内路径的导入/require 关系（含 tsconfig paths 别名，支持 extends 与多 target）。
- `dependencies.external`：第三方包导入与 manifest 声明的依赖。
- `entry_points`：web/cli/worker/scheduler/library 入口，附 evidence。
- `run_methods`：来自 package.json、pyproject、Makefile、Dockerfile、README 的运行命令，标注 source（命令已脱敏）。
- `symbols`：符号索引（函数、类、方法、导出），`parser` 标注实际解析器（默认 heuristic）。
- `graphs`：模块级调用图（nodes/edges/weight）与符号级引用图（symbol_references，带 confidence）。
- `git`：读到的 HEAD、分支、working_tree_clean（仅 statusText 提供时判定）和（通过文本提供的）变更文件；`compare` 记录 base/head ref。
- `risks`：动态 import/require 等无法可靠解析的依赖风险。
- `performance`：elapsed_ms、files_indexed、bytes_read、cache 命中、budgets 与 budget_exceeded。
- `limits.warnings`、`errors`：扫描限制与恢复性错误。

## 安全红线

- 只读：不写入目标仓库，不执行扫描目标中的任何脚本。
- 路径越界保护：`repo_path` 解析后拒绝 `..` 逃逸与绝对路径拼接。
- 不跟随符号链接，避免越界与循环。
- 不 spawn 子进程、不使用网络（由 `test/security.test.mjs` 可执行审计保障）。
- 输出自动屏蔽环境中常见 token/连接串/JWT 等敏感模式。
- 不做动态导入、反射、字符串拼接 import 的强行猜测，相关事实记入 `risks`。
