# Publishing

> 本文是 dsh-repo-scanner 的发布手册，结构遵循工作区顶层 docs/PUBLISHING-TEMPLATE.md 模板（该文件位于插件仓库之外，不在本仓库内）；其他插件仓库的 PUBLISHING.md 同构。

## 1. 命名与分发身份

- npm 包名：`dsh-repo-scanner`（与 GitHub 仓库名一致）。GitHub 仓库原名 `-dsh-repo-scanner`（建仓笔误）已于 2026-09-02 更名，旧链接自动重定向。
- bin 命令：`repo-scanner` 与 `dsh-repo-scanner`；exports 子路径 `dsh-repo-scanner/scanner`（扫描内核）；cordis.patch.yml 插件行 id/name 为 `dsh-repo-scanner`。
- README 双语：`README.md` 为英文、`README.zh-CN.md` 为中文，顶部互链；两者章节结构必须一致，改动描述时同步更新。

## 2. 发布前检查清单

1. 运行 `npm test`（功能 + 安全审计 + manifest 测试）与 `npm run check`（全模块语法检查）。
2. 运行 `npm run test:compat`（DSH 宿主兼容门禁）。
3. 运行 `npm pack --dry-run`，确认包含 `plugin/index.js`、`cordis.patch.yml`、`skills/`、`src/`、`bin/`、`docs/`、`examples/`、双语 `README.md`/`README.zh-CN.md`、`CHANGELOG.md`、`LICENSE`、`PUBLISHING.md`。
4. 版本一致性三处核对：`package.json`、`src/options.mjs` 的 `TOOL_VERSION`、CHANGELOG 与 git tag（另确认 `docs/output-schema.md` 与 `examples/sample-output.json` 中的 `tool.version` 同步为当前版本号）。
5. 版本徽章同步：双语 README 的 version 徽章与安装示例 tag 指向最新发布版本。
6. 输出契约核对：`schema_version` / `analysis_schema` 是输出契约版本，独立于包版本演进，已发布字段不删除。

## 3. DSH bundle 契约（对齐 2026-09 现行契约）

- `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`——harness 只激活声明该字段的包。
- `cordis.patch.yml` 为 config-tree `- insert:` 补丁格式；harness 加载 `main`（`plugin/index.js`）。
- `plugin/index.js` 经官方 `@deepseek-ai/dsh-skill-filesystem` 的 `FileSystemSkillProvider` 注册 `skills/` 为技能根（includeDefaultRoots: false）。
- `skills/repo-scanner-runbook/SKILL.md` frontmatter 必填 `name`（kebab-case）+ `description`。
- 扫描内核经 exports 子路径 `dsh-repo-scanner/scanner` 暴露；CLI bin 为 `repo-scanner` / `dsh-repo-scanner`。
- 安装契约：`dsh plugin --profile <profile> add "github:owner/repo#ref"`；兼容基线 `@deepseek-ai/dsh@0.1.5-rc.2`（Node >= 22.19）。

## 4. 发布渠道

### GitHub

1. push `main`，确认独立扫描器回归 CI 全绿（Node 18/20/22 × Windows/Ubuntu），并确认 Node 22.19 的 DSH compat job 通过。
2. 打 tag `v0.x.y`（与 `package.json` version 一致，如当前 `v0.1.2`）并推送。
3. 给仓库添加 GitHub topic `dsh-plugin`（awesome 收录门槛之一）。

### npm

1. `npm login`（bugcome 账号）。
2. `npm publish --access public`（`prepublishOnly` 会先跑 `npm test`）。
3. 发布后核对 `npm view dsh-repo-scanner version` 与 dist-tags。

### awesome 列表收录

- awesome-dsh-plugin（已收录）：改描述时同步 `data/plugins/duyanta123__dsh-repo-scanner.yml`。
- awesome-deepseek-harness：en/zh README 条目同一 PR 提交。
- 收录门槛实录（供其他仓参考）：仓库需创建满 1 天且 ≥10 个提交（自动检查，过滤一次性投稿仓；重提不受影响）——本仓建仓时大提交导致历史偏短，PR #4125 曾因 `repository has 6 commit(s) (needs 10)` 被拦，补齐契约测试、徽章等真实收尾提交后达到门槛；`package.json` 必须声明 `dsh.bundle`（只声明 `dsh.client` 会被拒）；需加 topic `dsh-plugin`；检查失败后向**同一分支**推送修复即可，无需重开 PR。
