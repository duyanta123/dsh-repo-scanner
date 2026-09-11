# dsh-repo-scanner 维护规则（Maintenance Runbook）

> 本文档是 dsh-repo-scanner 仓库的专属维护基准，与工作区顶层 docs/PLUGIN-MAINTENANCE.md 通用规则配套使用（该文件位于本仓库之外）。本文件聚焦本仓库的细节。
> 原则：**不改不动，要改就一步到位**——代码/技能、测试、CHANGELOG、版本号、tag 一起改，不留下半成品版本。

## 1. 仓库概况

| 项 | 值 |
|---|---|
| 类型 | 共享内核（只读仓库事实扫描，供分析型插件复用） |
| 当前版本 | 0.1.2 |
| 分发状态 | awesome-dsh-plugin / awesome-deepseek-harness 收录中；npm 包名与仓库名一致 |
| 运行时 | 零构建 ESM，Node >=18 独立运行；DSH 宿主 >=22.19 |
| 核心模块 | `src/`（filesystem/probe/modules/dependencies/entries/symbols/parsers/graphs/git/output/facts）+ `bin/repo-scanner.mjs` |

## 2. 目录结构与职责

```text
dsh-repo-scanner/
├── package.json              # npm 包 + dsh.bundle.patch + files 白名单 + bin（repo-scanner / dsh-repo-scanner）
├── cordis.patch.yml          # DSH bundle patch
├── plugin/index.js           # FileSystemSkillProvider 注册 skills/
├── skills/repo-scanner-runbook/SKILL.md   # 扫描 CLI runbook
├── src/                      # 扫描内核（exports 子路径 dsh-repo-scanner/scanner；正确性核心）
│   ├── options.mjs           # 参数与 TOOL_VERSION（版本三处同步点之一）
│   ├── output.mjs            # 输出契约（schema_version 1.0 外壳）
│   ├── facts.mjs             # 事实 API（change-impact / test-insight / doc-sync）
│   └── ...                   # filesystem / probe / modules / dependencies / entries / symbols / parsers / graphs / git / cache / errors
├── bin/repo-scanner.mjs      # CLI 入口
├── docs/                     # output-schema.md / scanning-rules.md / migration-guide.md（规划中）
├── examples/                 # 输出示例
└── test/                     # repo-scanner / security / manifest 测试 + dsh-compat 门禁
```

## 3. CI 与测试门禁

- **独立回归**：`npm test`（=`node --test test/repo-scanner.test.mjs test/security.test.mjs test/manifest.test.mjs`），37 例 + 1 项平台相关跳过。
- **语法门禁**：`npm run check`（全模块 `node --check`）。
- **DSH 宿主兼容**：`npm run test:compat` 固定 `@deepseek-ai/dsh@0.1.5-rc.2`，要求 Node >=22.19，执行临时 profile 的 add、dump-config 和有限时长启动。
- **GitHub Actions**：ubuntu + windows × Node 18/20/22 回归 + Node 22.19 compat job。
- **安全审计**：`test/security.test.mjs` 是安全红线的可执行保障——触碰任何红线的改动必须先补审计用例。

## 4. 一次完整变更的动作序列

1. 改代码 / 技能 / 文档
2. 补或更新测试用例（新增扫描能力/数据形态必须同步 fixture 与用例，禁止"加功能不改测试"）
3. 更新 `CHANGELOG.md`（先写 `Unreleased`）
4. 本地跑 `npm test`、`npm run check` 全绿
5. 有行为变更时改 `package.json` 的 `version`（semver）
6. 推送 `main`，GitHub Actions 全绿
7. 打 tag `v0.x.y` 并推送

## 5. 分场景维护细则

### 5.1 输出契约变更（`output.mjs` / `docs/output-schema.md`）
- `schema_version` 是输出契约版本，**独立于包版本演进**；已发布字段不删除、语义不变更。
- 新增字段必须同步：`docs/output-schema.md` 字段表、`examples/sample-output.json`、对应测试断言。

### 5.2 版本号三处同步（本仓特有）
- `package.json` 的 `version`、`src/options.mjs` 的 `TOOL_VERSION`、CHANGELOG 与 git tag 必须一致；`docs/output-schema.md` 与 `examples/sample-output.json` 中的 `tool.version` 也要同步。

### 5.3 安全红线变更
- 红线：不写入目标仓库、不装依赖、不执行项目代码、不 spawn 子进程、不越界、输出脱敏。
- 任何触碰红线的改动（如新增子进程调用）必须先补 `test/security.test.mjs` 审计用例并说明理由。

### 5.4 下游插件联动
- `dsh-test-insight` 已作为库依赖本包（npm dependency）；`arch-doc` / `dsh-refactor-insight` 的迁移见 `docs/migration-guide.md`（规划中，尚未执行）。
- 下游插件需要新事实字段时，走 facts API（`src/facts.mjs`）扩展，保持内核输出契约稳定。

### 5.5 元数据与打包
- 改动对外描述时同步：`README.md` / `README.zh-CN.md` 首段（双语，结构一致）、`package.json` 的 `description`/`keywords`、awesome 列表条目。
- 发版时同步双语 README 的 version 徽章、安装示例 tag 与示例 JSON 中的 `tool.version`。
- `files` 白名单已含 `plugin/`、`cordis.patch.yml`、`skills/`、`src`、`bin`、`docs`、`examples`、双语 `README.md`/`README.zh-CN.md`、`CHANGELOG.md`、`PUBLISHING.md`、`LICENSE`——`PLUGIN-MAINTENANCE.md` 与开发计划为仓库维护资产，不在 npm 包内。

## 6. 版本与发布节奏

- 多数改动为 **patch/minor**；输出契约不兼容变更时升 minor（0.x 阶段以 minor 代 major），并评估对下游 dsh-test-insight 的影响。
- 发布动作详见 [PUBLISHING.md](PUBLISHING.md)。

## 7. 发布前清单

- [ ] `npm test` 全绿（37 例 + 1 项平台相关跳过）
- [ ] `npm run check` 全过
- [ ] `npm run test:compat` 通过（DSH 0.1.5-rc.2 / Node 22.19+）
- [ ] `CHANGELOG.md` 已归并 `Unreleased`
- [ ] 版本号多处一致（package.json / TOOL_VERSION / CHANGELOG / tag / 文档与示例中的 tool.version）
- [ ] 双语 README 的 version 徽章与安装示例 tag 已同步
- [ ] `files` 字段包含所有应发布文件
- [ ] 对外描述若变，列表条目已同步（或已提交 PR）
- [ ] 推送 `main`，GitHub Actions 全绿
- [ ] 打并推送 tag `v0.x.y`
