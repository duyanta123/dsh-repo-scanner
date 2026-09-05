# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 约定。

## Unreleased

- 新增固定 `@deepseek-ai/dsh@0.1.2-rc.1` 的 `npm run test:compat` 门禁及 Windows/Ubuntu Node 22.19 CI，覆盖隔离 profile 的 add、配置 dump 和有限时长启动。
- 文档区分独立库/CLI 的 Node >=18 回归与 DSH 宿主 Node >=22.19 验证，并明确 `schema_version` 不随宿主版本升级。
- 修复插件入口遗漏 `skills` 服务注入声明的问题；该问题会使 DSH 0.1.2-rc.1 在启动阶段拒绝读取 `ctx.skills`。
- 新增 bundle 契约测试（`test/manifest.test.mjs`）：`dsh.bundle.patch` 声明、config-tree `- insert:` 格式、技能 frontmatter 必填 name（kebab-case）+ description——对齐期间的几类断裂今后在 CI 即可拦截。
- README 补 license / DSH / CI / version 徽章，对齐其余四仓样式。
- `prepublishOnly` 钩子：npm 发布前自动运行测试门禁。
- PUBLISHING.md 记录 awesome-dsh-plugin 收录门槛（仓库 ≥1 天 / ≥10 提交 / `dsh-plugin` topic）。

## 0.1.0 - 2026-09-02

首个对外版本。开发过程曾自标 `1.0.0`（2026-08-23 完成度快照），因从未对外发布、且 v1.0 验收目标（arch-doc / dsh-refactor-insight 经适配层复用内核）尚未达成，按语义化版本回落为 `0.1.0` 首发。

### DSH bundle 契约对齐（2026-09-02）

- `package.json` 声明 `dsh.bundle.patch`（现行 harness 只激活声明该字段的包），`main` 改指 `plugin/index.js`；扫描内核经 exports 子路径 `dsh-repo-scanner/scanner` 暴露，CLI bin 不变。
- `cordis.patch.yml` 重写为 config-tree `- insert:` 补丁格式，与 arch-doc / dsh-data-insight / dsh-refactor-insight / dsh-preset-scaffold 一致。
- `plugin/index.js` 重写为官方 `FileSystemSkillProvider` 标准模式（providerName / includeDefaultRoots: false / customSkillDirs + dispose effect），与 arch-doc 同构。
- `skills/repo-scanner-runbook/SKILL.md` 补充 frontmatter（`name` + `description`），满足现行技能识别规则（frontmatter 必填、name kebab-case）。
- 新增 optional peerDependencies `@deepseek-ai/dsh-skill-filesystem`。
- 版本统一：`package.json` 与 `TOOL_VERSION` 均为 `0.1.0`（`schema_version: 1.0` 为输出契约版本，独立于包版本，不受影响）。
- 文档清理：移除内部路线图遗留的 v0.2 / v0.3 / v1.0 特性标记；库接口示例统一改为 `dsh-repo-scanner/scanner` 导入。

### 修复（2026-08-23 完成度快照）

- 修复 `src/dependencies.mjs` 编码损坏导致整个包无法加载的 SyntaxError（注释与代码被合并到同一行）。
- `npm run check` 现在校验全部 `src/*.mjs`、`bin` 与 `plugin`，不再漏检源码模块。
- `working_tree_clean` 语义明确：仅当提供 statusText 时判定（空输出 = 干净），其余场景为 null。
- 修复行数统计对以换行结尾文件多算 1 行的问题；读取时剥离 UTF-8 BOM。
- `--hash` 的 sha256 改为按原始字节计算（此前对二进制文件哈希的是 UTF-8 转码结果）。
- 修复 tsconfig 位于子目录且 baseUrl 非根时别名解析基准目录错误的问题。
- 修复 `normalizeDirList` 将 `..` 规整为 `.` 绕过越界检查的问题。
- 修复 pyproject `[project]` / `[project.scripts]` 为最后一个 TOML 段时解析不到的问题。
- CLI 补齐已实现选项的旗标：`--follow-symlinks`、`--cache`、`--cache-dir`、`--parsers`、符号查询、性能预算；`--base/--head` 记录到 `git.compare`。

### 能力

- 增量扫描缓存：`cache: true`（按 mtime/size 失效，sha256 结果一并缓存；只写系统临时目录）。
- TS/JS import 别名解析增强：tsconfig `extends` 链、一个 pattern 多 target、JSONC 注释、baseUrl 裸模块名。
- OpenAPI/GraphQL/数据库迁移文件识别并呈现到 `project.openapi_files` / `graphql_files` / `db_migration_files`。
- 符号查询：`querySymbols` / `symbolQuery` 选项 / CLI `--symbol-name/--symbol-file/--symbol-module`。
- 可插拔解析器接口：`registerParser` / `resolveParserChain`；内置 heuristic；`tree-sitter` 为可选依赖，缺失时自动回退并写 `E_PARSER_UNAVAILABLE` 警告。
- 图分析模式 `--graphs`：模块级调用图 + 符号级引用图（命名导入解析到目标导出符号，带 confidence）。
- 统一 `dsh-analysis-schema`：输出外壳携带 `analysis_schema` 标识，供多个分析插件共享报告结构。
- 性能预算：`performance` 字段（elapsed_ms/files_indexed/bytes_read/cache 命中/budgets/budget_exceeded），默认 60000ms，超限写 `E_PERF_BUDGET_EXCEEDED` 警告。
- 大仓库增量索引：符号结果按文件缓存，未变化文件跳过重复解析。
- 可执行安全审计测试（`test/security.test.mjs`）：路径越界、符号链接逃逸、脱敏、内建模块白名单、无子进程/网络红线。
- 完整事实 API：`getChangeImpactFacts`（反向依赖传播）、`getTestInsightFacts`（测试↔源码映射与模块覆盖）、`getDocSyncFacts`（文档引用与过期引用）。
- 稳定 schema 兼容策略：已发布字段不删除，新增字段只做向后兼容增加。
- `extractSymbols` 为 async（解析器链可能加载可选依赖）；支持 heuristic 解析 `export { a as b }` 语句。
- fixtures：`ts-alias-app`（extends/多 target 别名）、`security-app`（脱敏）、monorepo API 契约文件、node-app README。
- CI：`.github/workflows/ci.yml`（Node 18/20/22 × Windows/Ubuntu）。
- 输出契约：schema 字段文档、扫描规则、示例输出与 README 同步。
