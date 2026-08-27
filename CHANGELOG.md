# Changelog

## v1.0.0 - 2026-08-23

### 修复

- 修复 `src/dependencies.mjs` 编码损坏导致整个包无法加载的 SyntaxError（注释与代码被合并到同一行）。
- `npm run check` 现在校验全部 `src/*.mjs`、`bin` 与 `plugin`，不再漏检源码模块。
- 统一版本号：`TOOL_VERSION`、`package.json`、`plugin/index.js` 均为 `1.0.0`。
- `working_tree_clean` 语义明确：仅当提供 statusText 时判定（空输出 = 干净），其余场景为 null。
- 修复行数统计对以换行结尾文件多算 1 行的问题；读取时剥离 UTF-8 BOM。
- `--hash` 的 sha256 改为按原始字节计算（此前对二进制文件哈希的是 UTF-8 转码结果）。
- 修复 tsconfig 位于子目录且 baseUrl 非根时别名解析基准目录错误的问题。
- 修复 `normalizeDirList` 将 `..` 规整为 `.` 绕过越界检查的问题。
- 修复 pyproject `[project]` / `[project.scripts]` 为最后一个 TOML 段时解析不到的问题。
- CLI 补齐已实现选项的旗标：`--follow-symlinks`、`--cache`、`--cache-dir`、`--parsers`、符号查询、性能预算；`--base/--head` 记录到 `git.compare`。

### v0.2 特性

- 增量扫描缓存：`cache: true`（按 mtime/size 失效，sha256 结果一并缓存；只写系统临时目录）。
- TS/JS import 别名解析增强：tsconfig `extends` 链、一个 pattern 多 target、JSONC 注释、baseUrl 裸模块名。
- OpenAPI/GraphQL/数据库迁移文件识别并呈现到 `project.openapi_files` / `graphql_files` / `db_migration_files`。
- 符号查询：`querySymbols` / `symbolQuery` 选项 / CLI `--symbol-name/--symbol-file/--symbol-module`。

### v0.3 特性

- 可插拔解析器接口：`registerParser` / `resolveParserChain`；内置 heuristic；`tree-sitter` 为可选依赖，缺失时自动回退并写 `E_PARSER_UNAVAILABLE` 警告。
- 图分析模式 `--graphs`：模块级调用图 + 符号级引用图（命名导入解析到目标导出符号，带 confidence）。
- 统一 `dsh-analysis-schema`：输出外壳携带 `analysis_schema` 标识，供多个分析插件共享报告结构。

### v1.0 特性

- 性能预算：`performance` 字段（elapsed_ms/files_indexed/bytes_read/cache 命中/budgets/budget_exceeded），默认 60000ms，超限写 `E_PERF_BUDGET_EXCEEDED` 警告。
- 大仓库增量索引：符号结果按文件缓存，未变化文件跳过重复解析。
- 可执行安全审计测试（`test/security.test.mjs`）：路径越界、符号链接逃逸、脱敏、内建模块白名单、无子进程/网络红线。
- 完整事实 API：`getChangeImpactFacts`（反向依赖传播）、`getTestInsightFacts`（测试↔源码映射与模块覆盖）、`getDocSyncFacts`（文档引用与过期引用）。
- 稳定 schema 兼容策略：已发布字段不删除，新增字段只做向后兼容增加。

### 其他

- `extractSymbols` 变为 async（解析器链可能加载可选依赖）；新增 heuristic 对 `export { a as b }` 语句的解析。
- 新增 fixtures：`ts-alias-app`（extends/多 target 别名）、`security-app`（脱敏）、monorepo API 契约文件、node-app README。
- 新增 `.github/workflows/ci.yml`（Node 18/20/22 × Windows/Ubuntu）与 `.gitignore`。
- schema 字段文档、扫描规则、示例输出与 README 全量同步。

## v0.1.0 - 2024-01-01

- 初始版本：只读仓库事实扫描内核。
- CLI 支持 `--probe --files --scan --deps --entry --symbols --git --all`。
- 库接口 `scanRepository` 与纯函数模块。
- 统一输出外壳 `schema_version: 1.0`。
- Python/Node/Go/monorepo fixtures 与 node:test 测试。
- DSH plugin 与 `repo-scanner-runbook` 技能。