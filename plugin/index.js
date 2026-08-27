/**
 * DeepSeek Harness 插件入口。
 *
 * 只负责注册 `repo-scanner-runbook` 技能；核心扫描逻辑始终通过
 * `dsh-repo-scanner` 库接口或 CLI 调用，避免技能文本里出现实现细节。
 */
export default function dshRepoScannerPlugin(ctx) {
  const skill = {
    name: 'repo-scanner-runbook',
    description: 'Read-only repository fact scanner runbook (probe/files/scan/deps/entry/symbols/git).',
    entry: 'SKILL.md',
  };

  if (ctx && typeof ctx.registerSkill === 'function') {
    ctx.registerSkill(skill);
  }
  return skill;
}

export const name = 'dsh-repo-scanner';
export const version = '1.0.0';