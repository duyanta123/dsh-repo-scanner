# Scanning Rules

## 目录安全

- 默认排除：`.git`、`node_modules`、`dist`、`build`、`coverage`、`.venv`、`target`、缓存与 IDE 目录。
- `--include-dirs` 只影响子目录递归；仓库根目录下的文件始终保留。
- `--exclude-dirs` 在任何层级按目录名排除，规则同样作用于根目录。
- 第一版不跟随符号链接；开启 `--follow-symlinks` 也仅限仓库内部链接。
- `max_depth` 从仓库根开始计算：根目录文件 depth=0，`src/a.ts` depth=1。

## 语言识别

| 语言 | 依据 |
| --- | --- |
| javascript | `.js` `.mjs` `.cjs` `.jsx` |
| typescript | `.ts` `.mts` `.cts` `.tsx` |
| python | `.py` |
| go | `.go` |
| java | `.java` |
| kotlin | `.kt` `.kts` |

文件 kind 分类顺序：manifest → config → test → docs → asset → source → unknown。

## 模块识别

- JS/TS：`src/<dir>`、`lib/<dir>`；monorepo 下 `packages/*`、`apps/*`。
- Python：`src/<package>` 顶层包目录；不评估职责。
- Go：`cmd/<name>`、`internal/<name>`、`pkg/<name>`。
- Java/Kotlin：`src/main/java`、`src/main/kotlin` 下按包路径聚合。

## 依赖解析

- internal：能解析到仓库内路径的 import/require/from/include。
- external：package 导入 + manifest 版本声明。
- 动态 import/require、变量 spec 不猜测 target，记入 `risks`。
- JS/TS 相对路径解析扩展名：`.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` `.json` 与目录 index。
- TypeScript `paths` 别名（v0.2 增强）：
  - 支持 tsconfig `extends` 链（相对路径，最多 5 层，子配置优先）。
  - 一个 pattern 的多个 target 按声明顺序依次尝试。
  - 支持 JSONC（`//` 与 `/* */` 注释）。
  - `baseUrl` 相对于 tsconfig 文件所在目录；裸模块名仅当 baseUrl 非根时保守匹配。
- Python：相对导入、`__init__.py` 包、无 `__init__.py` 的 src 布局命名空间包。
- Go：`go.mod` module 前缀导入；目录导入取该目录内首个 `.go` 文件。

## 符号解析（v0.3 可插拔解析器）

- 默认 `heuristic`：零依赖正则启发式，输出带 `confidence`。
- `parsers: ['tree-sitter']`：可选依赖；未安装时自动回退 heuristic 并写入 `E_PARSER_UNAVAILABLE` 警告。
- 第三方可通过 `registerParser(name, { languages, extractFile })` 注册自定义解析器。
- 启用 `cache` 后符号结果随文件缓存（mtime/size 失效），未变化文件不重复解析。

## 增量缓存（v0.2 / v1.0 增量索引）

- `cache: true` 开启；缓存只写系统临时目录（`--cache-dir` 可自定义），绝不写目标仓库。
- 按文件 `mtime + size` 判定失效；`--hash` 时缓存 sha256 结果。
- 文本与符号索引均增量复用；缓存命中不改变扫描结果（可复现性保持）。

## 性能预算（v1.0）

- 默认预算 60000ms（`--perf-budget-ms`，0 关闭）；超限写入 `limits.warnings`（`E_PERF_BUDGET_EXCEEDED`）。
- `performance` 字段记录 elapsed_ms、files_indexed、bytes_read、cache 命中与 budgets。

## 安全审计（v1.0）

- 可执行审计测试（`test/security.test.mjs`）：路径越界、符号链接、脱敏、内建模块白名单、无子进程/网络。
- 输出对 password/token/api key、数据库连接串、JWT 做脱敏。

## Git

- 不写 checkout/reset/clean；不靠子进程获取 Git 数据。
- 只读 `.git/HEAD`、分支引用与用户提供的 diff/status 文本。
- diff 文本解析支持 `new file mode`、`deleted file mode`、`rename from/to`、`copy from/to` 与 hunk 增删行统计。