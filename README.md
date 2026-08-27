# dsh-repo-scanner

面向 DeepSeek Harness 分析型插件（`arch-doc`、`dsh-refactor-insight`、`dsh-change-impact`、`dsh-test-insight`）的统一、可复现、只读的代码库事实扫描内核。

只读：不修改目标仓库，不安装依赖，不执行项目代码。

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
import { scanRepository } from 'dsh-repo-scanner';

const report = await scanRepository({
  repoPath: '.',
  modes: ['probe', 'modules', 'dependencies', 'entries', 'symbols', 'graphs', 'git'],
  maxDepth: 3,
  cache: true,                 // v0.2 增量扫描缓存
  parsers: ['heuristic'],      // v0.3 可插拔解析器（tree-sitter 为可选依赖）
  symbolQuery: { name: 'auth' }, // v0.2 符号查询
  git: { diffText },
});
```

### 事实 API（v1.0）

```js
import {
  getChangeImpactFacts, // 变更影响：反向依赖传播 + 受影响模块/符号
  getTestInsightFacts,  // 测试洞察：测试↔源码映射 + 模块覆盖
  getDocSyncFacts,      // 文档同步：文档引用 + 过期引用
} from 'dsh-repo-scanner';

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
  "tool": { "name": "dsh-repo-scanner", "version": "1.0.0" },
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
| `--strict` | 关 | 输出校验失败时非零退出 |
| `--follow-symlinks` | 关 | 跟随符号链接（目标必须在仓库内） |
| `--cache` / `--cache-dir DIR` | 关 | v0.2 增量扫描缓存（只写临时目录） |
| `--parsers a,b` | heuristic | v0.3 符号解析器链（tree-sitter 为可选依赖，缺失自动回退） |
| `--symbol-name/file/module` | 空 | v0.2 符号查询过滤 |
| `--perf-budget-ms N` | 60000 | v1.0 性能预算（0 关闭；超限写 warning） |

退出码：`0` 成功；`1` 扫描完成但有可恢复警告；`2` 参数错误或仓库路径无效；`3` 输出失败或契约错误。

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
npm run check
```

Node >=18。
