import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DSH bundle 契约测试：守住「插件能被 dsh plugin add 安装并激活」的最小条件。
 *
 * 背景：2026-09 对齐时发现 cordis.patch.yml 用过自造 schema、SKILL.md 缺
 * frontmatter——这类断裂不经过 harness 真机不会暴露，因此在此固化为契约：
 *  1. package.json 声明 dsh.bundle.patch 且指向存在的 manifest，main 指向存在的插件入口；
 *  2. cordis.patch.yml 为 config-tree `- insert:` 列表，id/name 与包名一致；
 *  3. 每个 skills/<dir>/SKILL.md 有 frontmatter，name 为 kebab-case 且与目录名一致，description 非空。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('bundle manifest: package.json declares dsh.bundle.patch and a loadable main', () => {
  const patchPath = pkg.dsh?.bundle?.patch;
  assert.ok(patchPath, 'package.json must declare dsh.bundle.patch (otherwise dsh plugin add installs the package but never activates it)');
  assert.ok(existsSync(join(root, patchPath)), `dsh.bundle.patch target not found: ${patchPath}`);
  assert.ok(pkg.main, 'package.json must declare main (harness loads it as the plugin entry)');
  assert.ok(existsSync(join(root, pkg.main)), `main entry not found: ${pkg.main}`);
  assert.equal(pkg.exports?.['.'], pkg.main, 'exports "." must resolve to the plugin entry (library consumers use the ./scanner subpath)');
});

test('bundle manifest: cordis.patch.yml uses the config-tree insert format', () => {
  const raw = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8');
  assert.match(raw, /-\s+insert:/, 'manifest must be a config-tree patch: "- insert:" list');
  assert.match(raw, new RegExp(`(?:-\\s+)?id:\\s*${pkg.name}`), 'insert row id must identify this plugin');
  assert.match(raw, new RegExp(`(?:-\\s+)?name:\\s*${pkg.name}`), 'insert row name must identify this plugin');
  assert.doesNotMatch(raw, /^\s*entry:\s*|\bversion:\s*\d/, 'manifest must not use the rejected name/version/entry schema');
});

test('skill frontmatter: every skills/<dir>/SKILL.md declares name (kebab-case, matches dir) and description', () => {
  const skillsDir = join(root, 'skills');
  assert.ok(existsSync(skillsDir), 'skills/ directory must exist');
  const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  assert.ok(dirs.length > 0, 'at least one skill directory expected');
  for (const dir of dirs) {
    const skillFile = join(skillsDir, dir, 'SKILL.md');
    assert.ok(existsSync(skillFile), `missing SKILL.md for skill dir: ${dir}`);
    const raw = readFileSync(skillFile, 'utf8');
    assert.match(raw, /^---\r?\n/, `${dir}/SKILL.md must start with frontmatter (provider ignores skills without it)`);
    const fm = raw.split(/^---\r?\n/m)[1] ?? '';
    const name = fm.match(/^name:\s*(\S+)/m)?.[1];
    const description = fm.match(/^description:\s*(\S.*)$/m)?.[1];
    assert.ok(name, `${dir}/SKILL.md frontmatter must declare name`);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${dir}/SKILL.md name must be kebab-case, got: ${name}`);
    assert.equal(name, dir, `${dir}/SKILL.md name should match its directory name`);
    assert.ok(description && description.trim().length > 10, `${dir}/SKILL.md frontmatter must declare a meaningful description`);
  }
});
