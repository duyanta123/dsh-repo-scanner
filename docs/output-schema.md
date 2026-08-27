# Output Schema v1.0

所有命令输出统一外壳。字段名使用 snake_case；路径使用 POSIX `/`；行号从 1 开始。

## 兼容策略（v1.0）

- 已发布字段不删除、不改语义；新增字段只做向后兼容增加。
- 只有发生不兼容变化时才升级 `schema_version` 主版本。
- `schema_version: "1.0"` 自 v0.1 起保持稳定；v1.0 新增 `analysis_schema`、`graphs`、`performance` 均为增量字段。

## 外壳

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| schema_version | string | 固定 `"1.0"` |
| analysis_schema | object | `dsh-analysis-schema` 标识（name/version），供多个分析插件共享报告结构 |
| tool.name | string | `"dsh-repo-scanner"` |
| tool.version | string | 包版本 |
| input.repo_path | string | 调用方传入的原始 repo_path |
| input.resolved_path | string | 规范化后的绝对路径 |
| input.options | object | 当前扫描选项摘要（modes/language/hash/strict/follow_symlinks/cache/parsers/symbol_query） |
| limits.max_depth | number | 最大目录深度 |
| limits.max_files | number | 最大文件数 |
| limits.max_file_bytes | number | 单文件内容读取上限 |
| limits.truncated | boolean | 是否因上限发生截断 |
| limits.warnings | array | 可恢复警告（含解析器回退、性能预算超限） |
| project | object | probe 结果；无能力时可为空对象 |
| files | array | 文件索引 |
| modules | array | 模块识别结果 |
| dependencies.internal | array | 仓库内依赖，必须能解析到内部路径 |
| dependencies.external | array | 第三方依赖导入与 manifest 声明 |
| entry_points | array | 入口分类（web/cli/worker/scheduler/library） |
| run_methods | array | 运行命令与来源（命令经过脱敏） |
| symbols | array | 符号索引，`parser` 字段标注实际使用的解析器 |
| graphs | object/null | graphs 模式时输出模块调用图与符号引用图，否则为 null |
| risks | array | 无法可靠解析的依赖等风险 |
| errors | array | 扫描过程中无法恢复的错误（默认保持空） |
| performance | object/null | 实测性能指标与预算（elapsed_ms/files_indexed/bytes_read/cache/budgets/budget_exceeded） |
| git | object/null | git 模式时输出，否则为 null |

## project 字段（probe）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| name / description | string/null | 来自 manifest 或目录名 |
| language | string/null | 主语言 |
| repo_type | string | monolith/monorepo/library/service/cli/unknown |
| repo_type_evidence | array | 判定证据 |
| tech_stack | array | 技术栈标签 |
| manifest_files | array | manifest 文件路径 |
| openapi_files | array | OpenAPI/Swagger 契约文件（v0.2） |
| graphql_files | array | GraphQL schema 文件（v0.2） |
| db_migration_files | array | 数据库迁移文件（v0.2） |
| file_count / source_file_count | number | 文件统计 |
| language_evidence | array | 主语言证据文件 |
| confidence | string | high/medium |

## graphs 字段（v0.3）

```json
{
  "module_call_graph": {
    "nodes": [{"name": "api", "path": "src/api", "file_count": 1}],
    "edges": [{"source": "src/api", "target": "src/auth", "weight": 2, "imports": [{"source": "...", "target": "..."}]}]
  },
  "symbol_references": [
    {"source_file": "src/api/server.ts", "target_file": "src/auth/service.ts", "symbol": "AuthService", "kind": "named-import", "line": 2, "confidence": "high"}
  ]
}
```

- `weight`：聚合到模块维度的导入语句数量。
- `symbol_references.kind`：named-import / default-import / namespace-import / from-import / star-import。
- 只输出可解析的事实边；无法确认的绑定不强行猜测。

## git 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| available | boolean | 是否找到 .git 目录 |
| head_ref / branch / head_sha | string/null | 从 .git/HEAD 只读解析 |
| working_tree_clean | boolean/null | 仅当提供 statusText 时可判定；不可判定时为 null |
| changed_files | array | 调用方提供的 diff/status/清单解析结果 |
| compare | object | 调用方提供的 base/head ref（供变更影响分析记录） |
| method | string/null | changed_files 的来源方式 |
| warnings | array | Git 相关警告 |

## 事实 API 输出（v1.0）

`getChangeImpactFacts` / `getTestInsightFacts` / `getDocSyncFacts` 返回独立外壳（含 schema_version、analysis_schema、tool），字段：

- 变更影响：`changed_files`、`impacted_files`（path/via/depth，最大传播深度 3）、`impacted_modules`、`impacted_symbols`。
- 测试洞察：`test_files`（test_file→target_file 映射）、`orphan_tests`、`module_test_coverage`（module/name/source_file_count/has_tests/tested_files）、`source_files_without_tests`。
- 文档同步：`docs`（doc/referenced_source_files/reference_count）、`docs_with_stale_references`、`stale_references`（doc/path）、`source_files_without_doc_references`。

## 空值约定

- 空集合统一返回 `[]`。
- 不存在的可选对象使用 `null`。
- 语言无法识别时为 `null`。
- `lines`/`sha256` 未读取时为 `null`。

## 稳定路径示例

```json
{
  "path": "src/auth/service.ts"
}
```

禁止出现反斜杠路径；Windows 扫描必须转换为 POSIX 分隔符。
