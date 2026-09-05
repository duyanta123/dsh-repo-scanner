/**
 * dsh-repo-scanner — DSH (DeepSeek Harness) 插件入口。
 *
 * 复用官方 @deepseek-ai/dsh-skill-filesystem 提供者，把本包自带的 skills/
 * 目录注册为技能根（includeDefaultRoots: false，避免与宿主 profile 的
 * 技能根重复）。零构建：本 ESM 模块由 harness 直接加载。
 *
 * 扫描内核不在此处加载：技能 runbook 指引通过 shell 调用 bin/repo-scanner.mjs，
 * 上层插件按需经 exports 子路径 `dsh-repo-scanner/scanner` 引入库接口。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";

export const name = "dsh-repo-scanner";
export const inject = ["skills"];

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(rootDir, "skills");

export function apply(ctx, config = {}) {
  let provider;
  ctx.skills.registerProvider((control) => {
    provider = new FileSystemSkillProvider(ctx, control, {
      providerName: "dsh-repo-scanner",
      includeDefaultRoots: false,
      customSkillDirs: [skillsDir],
      ...config,
    });
    return provider;
  });
  ctx.effect(
    function* () {
      yield async () => {
        await provider?.dispose();
      };
    },
    "dsh-repo-scanner skill provider"
  );
}
