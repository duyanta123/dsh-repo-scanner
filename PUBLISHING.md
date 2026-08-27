# Publishing

1. 运行 `npm test` 和 `npm run check`，确保全部通过。
2. 运行 `npm pack --dry-run`，确认包含 `src/`、`bin/`、`plugin/`、`skills/`、`docs/`、`examples/`、`README.md`、`CHANGELOG.md`、`LICENSE`。
3. 发布前确认 `schema` 文档与 `examples/sample-output.json` 与实际输出一致。
4. 提升 `package.json`、`CHANGELOG.md` 与 git tag 版本号。

## DSH bundle

- `plugin/index.js` 只注册 `repo-scanner-runbook` 技能。
- 技能说明见 `skills/repo-scanner-runbook/SKILL.md`。