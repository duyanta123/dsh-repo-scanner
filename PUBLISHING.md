# Publishing

1. 运行 `npm test` 和 `npm run check`，确保全部通过。
2. 运行 `npm pack --dry-run`，确认包含 `plugin/index.js`、`cordis.patch.yml`、`skills/`、`src/`、`bin/`、`docs/`、`examples/`、`README.md`、`CHANGELOG.md`、`LICENSE`、`PUBLISHING.md`。
3. 发布前确认 `docs/output-schema.md` 与 `examples/sample-output.json` 与实际输出一致（`tool.version` 同步为当前版本号）。
4. 提升 `package.json`、`src/options.mjs` 的 `TOOL_VERSION`、`CHANGELOG.md` 与 git tag 版本号，保持一致。

## DSH bundle（已对齐 2026-09 现行契约）

- `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`——harness 只激活声明该字段的包。
- `cordis.patch.yml` 为 config-tree `- insert:` 补丁格式；harness 加载 `main`（`plugin/index.js`）。
- `plugin/index.js` 经官方 `@deepseek-ai/dsh-skill-filesystem` 的 `FileSystemSkillProvider` 注册 `skills/` 为技能根（includeDefaultRoots: false）。
- `skills/repo-scanner-runbook/SKILL.md` frontmatter 必填 `name`（kebab-case）+ `description`。
- 扫描内核经 exports 子路径 `dsh-repo-scanner/scanner` 暴露；CLI bin 不变。

## 发布渠道

1. push `main`，确认 GitHub Actions CI 全绿（Node 18/20/22 × Windows/Ubuntu）。（2026-09-02 首推已绿）
2. 打 tag `v0.1.0` 并推送。（已完成）
3. （可选）`npm publish --access public`。
4. 提交收录：awesome-dsh-plugin（`data/plugins/duyanta123__dsh-repo-scanner.yml`）与 awesome-deepseek-harness（en/zh README 条目，同一 PR）。

> 注：GitHub 仓库原名 `-dsh-repo-scanner`（建仓笔误）已于 2026-09-02 更名为 `dsh-repo-scanner`，旧链接自动重定向。
