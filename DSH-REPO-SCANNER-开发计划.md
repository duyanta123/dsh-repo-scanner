# dsh-repo-scanner 详细开发计划

> 定位：为 DeepSeek Harness 分析型插件提供统一、可复现、只读的代码库事实扫描内核。
>
> 目标：把分散在 `arch-doc`、`dsh-refactor-insight` 等插件中的仓库探测、模块识别、依赖提取、入口识别和符号定位能力收敛为一个稳定的共享包。

## 1. 项目概览

### 1.1 产品定位

`dsh-repo-scanner` 不是代码审查器，也不是架构文档生成器。它只负责从本地仓库提取确定性事实，供上层插件进行语义分析和报告生成。

核心原则：

- 只读：不修改目标仓库，不安装依赖，不执行目标项目代码。
- 可复现：相同仓库快照和相同参数应得到稳定结果。
- 事实与推断分离：扫描器输出路径、行号、依赖和命令等硬事实，不输出未经验证的职责判断。
- 零运行时依赖优先：第一版使用 Node.js 内建模块，避免沙箱内的子进程和原生依赖问题。
- 渐进式扫描：先获取低成本元数据，只有必要时才读取源码内容。
- 可供 CLI 和 DSH 插件复用：核心函数可被脚本调用，CLI 输出 JSON，技能层负责组织工作流。

### 1.2 目标用户

- `arch-doc`：生成架构文档。
- `dsh-refactor-insight`：检测坏味道和模块耦合。
- `dsh-change-impact`：分析 Git 变更影响范围。
- `dsh-test-insight`：发现测试缺口。
- 直接使用 CLI 的开发者和 CI 流程。

### 1.3 非目标

第一版不做：

- 完整 AST 解析器。
- 代码格式化或自动重构。
- 依赖安装、构建、测试和部署。
- 运行时调用追踪。
- GitHub、GitLab 等远程 API 集成。
- 对动态导入、反射和字符串拼接进行强行猜测。

## 2. 与现有项目的关系

当前 `arch-doc` 和 `dsh-refactor-insight` 都有自己的 `arch-profile.mjs`。共享内核提取后，建议采用以下迁移顺序：

1. 先复制现有行为并建立兼容测试，保证输出字段不丢失。
2. 把扫描逻辑移动到 `dsh-repo-scanner`。
3. 在两个上层插件中通过 CLI 或库接口调用共享包。
4. 保留旧命令一段时间，提供兼容包装器。
5. 等两个插件的输出稳定后，再删除重复实现。

建议仓库结构：

```text
dsh-repo-scanner/
├── package.json
├── README.md
├── CHANGELOG.md
├── LICENSE
├── PUBLISHING.md
├── cordis.patch.yml
├── plugin/index.js
├── src/
│   ├── index.mjs
│   ├── options.mjs
│   ├── filesystem.mjs
│   ├── probe.mjs
│   ├── modules.mjs
│   ├── dependencies.mjs
│   ├── entries.mjs
│   ├── symbols.mjs
│   ├── git.mjs
│   ├── output.mjs
│   └── errors.mjs
├── bin/repo-scanner.mjs
├── skills/repo-scanner-runbook/SKILL.md
├── docs/
│   ├── output-schema.md
│   ├── scanning-rules.md
│   └── migration-guide.md
├── examples/
│   ├── sample-output.json
│   └── README.md
└── test/
    ├── fixtures/
    └── repo-scanner.test.mjs
```

## 3. 功能分层

### 3.1 `probe`：仓库基本探测

输入仓库路径，输出：

- 项目名称和描述来源。
- 主语言及识别依据。
- 仓库类型：monolith、monorepo、library、service、cli 或 unknown。
- 技术栈和 manifest 文件。
- 文件数量、源码文件数量和扫描限制。

识别优先级应沿用现有 `arch-doc` 规则，并把每个结论附带 `evidence`：

```json
{
  "language": "typescript",
  "evidence": ["tsconfig.json", "package.json"]
}
```

### 3.2 `files`：文件索引

输出每个纳入扫描的文件：

- `path`：统一使用 `/` 的相对路径。
- `kind`：source、test、config、manifest、docs、asset、unknown。
- `language`。
- `bytes`、`lines`。
- 可选 `sha256`，默认关闭，避免大仓库扫描过慢。

默认排除：`.git`、`node_modules`、`dist`、`build`、`coverage`、`.venv`、`target`、缓存和 IDE 目录。支持 `include_dirs`、`exclude_dirs`、`max_depth`、`max_files` 和 `max_file_bytes`。

### 3.3 `scan`：模块识别

按语言和目录约定识别模块：

- JavaScript/TypeScript：`src`、`lib`、`packages`、`apps`。
- Python：`src`、`app`、顶层 Python package。
- Go：`cmd`、`internal`、`pkg`。
- Java/Kotlin：`src/main/java` 下的包路径。
- 通用项目：`src`、`app`、`lib`、`packages`。

每个模块输出：

```json
{
  "name": "auth",
  "path": "src/auth",
  "language": "typescript",
  "file_count": 8,
  "key_files": ["src/auth/service.ts"],
  "evidence": ["directory", "source_files"]
}
```

模块职责由上层 LLM 推断，扫描器保留空字段或不输出该字段，避免把命名启发式伪装成事实。

### 3.4 `deps`：依赖关系

输出两组依赖：

- `internal`：仓库内模块或文件之间的导入关系。
- `external`：第三方包及其 manifest 中声明的版本。

内部依赖至少包含：

```json
{
  "source": "src/api/routes.ts",
  "target": "src/auth/service.ts",
  "kind": "import",
  "spec": "../auth/service",
  "line": 4,
  "confidence": "high"
}
```

规则：

- 只把能解析到仓库内路径的导入归为 internal。
- 动态导入、变量 require 和反射调用放入 `risks`，不硬猜 target。
- 同一 source/target 的重复导入可以合并，但保留 `locations`。
- 外部依赖版本来自 package.json、pyproject.toml、go.mod 或 pom.xml。

### 3.5 `entry`：入口与运行方式

识别：

- web：FastAPI、Flask、Express、Go HTTP、Spring Boot 等。
- cli：`bin/`、`cmd/`、`cli.py`、argparse、commander、cobra 等。
- worker：worker、consumer、queue、Celery、BullMQ 等。
- scheduler：cron、scheduler、定时任务等。
- library：导出包但没有可执行入口。

运行方式来自：

- package.json scripts。
- pyproject 的 `[project.scripts]`。
- Makefile。
- Dockerfile 与 compose 文件。
- README 中的命令，但必须标记 `source: readme`，不可与 manifest 命令等同对待。

### 3.6 `symbols`：符号索引

第一版采用轻量规则，不引入完整 AST：

- 函数/方法名、起始行、结束行和语言。
- 类/接口/struct 名称及范围。
- export、public、package 等可见性提示。
- 文件级导出列表。

输出必须包含 `confidence` 和 `parser: heuristic`。无法可靠解析时返回局部结果并记录风险，不返回伪精确的范围。

### 3.7 `git`：变更基线支持

为后续 `dsh-change-impact` 预留只读接口：

- 当前 HEAD、分支名和工作树是否干净。
- 两个 commit 之间的 changed files。
- 工作区相对 HEAD 的 changed files。
- 每个文件的 status、旧路径、新路径。
- 可选 diff hunks 和新增/删除行号。

第一版可以把 Git 解析实现为独立模块，CLI 通过宿主 shell 获取 diff 文本时也能使用，不要求所有场景都依赖 Git。

## 4. 统一输出契约

所有命令输出统一外壳：

```json
{
  "schema_version": "1.0",
  "tool": {
    "name": "dsh-repo-scanner",
    "version": "0.1.0"
  },
  "input": {
    "repo_path": ".",
    "resolved_path": "C:/work/app",
    "options": {}
  },
  "limits": {
    "max_depth": 3,
    "max_files": 2000,
    "max_file_bytes": 256000,
    "truncated": false,
    "warnings": []
  },
  "project": {},
  "files": [],
  "modules": [],
  "dependencies": {
    "internal": [],
    "external": []
  },
  "entry_points": [],
  "run_methods": [],
  "symbols": [],
  "risks": [],
  "errors": []
}
```

契约规则：

- 字段名使用 snake_case，与现有插件输出保持一致。
- 不删除已发布字段；新增字段只做向后兼容增加。
- 空集合统一返回 `[]`，不存在的可选对象使用 `null`，不使用多种空值表达。
- 所有路径使用 POSIX 分隔符。
- 行号从 1 开始。
- 所有不确定结论必须包含 `confidence` 或 `evidence`。
- `schema_version` 发生不兼容变化时才升级主版本。

## 5. CLI 设计

本 CLI 面向**直接使用者和 CI**。上层插件（如 `dsh-change-impact`、`dsh-test-insight`）必须以 **npm `dependency`** 方式引用本包并走库接口（见第 6 节），而不是相对路径调用本 CLI，这样才能随安装自动携带依赖、不受安装位置影响。

```bash
node bin/repo-scanner.mjs <repo_path> --probe
node bin/repo-scanner.mjs <repo_path> --files
node bin/repo-scanner.mjs <repo_path> --scan
node bin/repo-scanner.mjs <repo_path> --deps
node bin/repo-scanner.mjs <repo_path> --entry
node bin/repo-scanner.mjs <repo_path> --symbols
node bin/repo-scanner.mjs <repo_path> --git --base <ref>
node bin/repo-scanner.mjs <repo_path> --all --json
```

通用参数：

```text
--max-depth N
--max-files N
--max-file-bytes N
--include-dirs a,b
--exclude-dirs a,b
--language LANG
--format json|jsonl
--hash
--strict
```

退出码：

- `0`：成功。
- `1`：扫描完成但有可恢复警告。
- `2`：参数错误或仓库路径无效。
- `3`：输出失败或契约错误。

`--strict` 下遇到无法读取的重要 manifest、路径越界或输出校验失败时退出非零；默认模式保留部分结果并写入 `warnings`。

## 6. 库接口与插件入口

建议公开接口：

```js
import { scanRepository } from "dsh-repo-scanner";

const report = await scanRepository({
  repoPath,
  modes: ["probe", "modules", "dependencies", "entries", "symbols", "git"],
  git: { base, head }, // 变更场景传入；无需两个 ref 时可省略
  maxDepth: 3,
});
```

`modes` 取值对应 CLI 的 `--probe`、`--scan`（modules）、`--deps`、`--entry`、`--symbols`、`--git`，上层插件按需选取，不应引入等价但不同名的拼写。变更类信息通过顶层 `git` 选项传入，与 CLI 的 `--git --base <ref> --head <ref>` 对齐。

内部模块保持纯函数优先：

- `discoverFiles(options)`
- `probeProject(files, options)`
- `scanModules(files, context)`
- `analyzeDependencies(files, modules, context)`
- `detectEntryPoints(files, context)`
- `extractSymbols(files, context)`
- `inspectGit(repoPath, options)`

作为上层插件的 npm 依赖发布时，本包必须满足以下条件，供 `import` 和 `resolve` 正常引用：

- `package.json` 的 `exports` 暴露库入口（如 `scanRepository`），并配置 `files` 使 `src/`、`bin/`、`plugin/`、`skills/`、`docs/` 均打入发布包。
- `bin/repo-scanner.mjs` 顶含 `#!/usr/bin/env node` shebang，并在 `package.json` 的 `bin` 字段中声明；脚本通过 `node --check`。
- `source` 依赖为零或仅内建模块，确保安装后无需额外编译或原生构建。

DSH 插件入口只负责注册 `repo-scanner-runbook`，不把核心扫描逻辑放进技能文本。技能说明调用 CLI 并解释输出字段，报告生成由上层插件完成。

## 7. 安全与性能设计

### 安全

- 解析前将 `repo_path` 规范化，拒绝扫描范围逃逸。
- 不跟随默认符号链接，避免循环和越界；提供显式 `--follow-symlinks` 但第一版关闭。
- 不执行仓库中的脚本、Makefile、Dockerfile 或测试命令。
- 输出中对环境变量、连接串和 token 做脱敏。
- Git diff 只读，禁止 `checkout`、`reset`、`clean` 等写操作。
- 读取文件失败时记录相对路径和错误类别，不泄漏完整系统路径。

### 性能

- 先目录扫描，再按模式读取必要文件。
- 单文件超过默认字节上限时跳过内容解析，但仍保留文件索引。
- 大于 2000 个源码文件时默认只做顶层模块扫描，并在 `limits.truncated` 中说明。
- 依赖分析使用缓存的文件文本，避免重复读取。
- 可选输出 `--hash`，默认不计算哈希。
- 不在运行时脚本中 spawn 子进程，避免 DSH 沙箱中的 EPERM 问题。

## 8. 分阶段实施

### Phase 0：契约与迁移基线

- 从 `arch-doc` 和 `dsh-refactor-insight` 收集现有 JSON 样例。
- 固定 `schema_version: 1.0`。
- 建立 Python、Node、Go 三个 fixture，并加入 monorepo fixture。
- 对现有行为建立快照测试。

验收：旧插件的核心字段都能在新契约中找到；无路径格式回归。

### Phase 1：文件、探测、模块

- 实现安全遍历、过滤、文件分类和大小统计。
- 实现语言、仓库类型、技术栈和 manifest 探测。
- 实现模块识别、关键文件排序和目录树。
- 实现 `--probe`、`--files`、`--scan`。

验收：四种 fixture 在 Windows 和 Linux 路径下结果稳定；排除目录不出现在任何结果中。

### Phase 2：依赖、入口、运行方式

- 迁移现有 `arch-profile` 的依赖识别逻辑。
- 增加 TypeScript path alias、Python package、Go package 的基础支持。
- 增加入口分类和运行命令来源标记。
- 实现 `--deps`、`--entry`。

验收：内部/外部依赖数量和来源与现有测试一致；动态导入进入风险列表。

### Phase 3：符号索引

- 提取函数、类、方法和导出符号。
- 输出起止行和解析置信度。
- 对字符串、注释和模板内容做屏蔽，减少误匹配。
- 实现 `--symbols`。

验收：每种语言 fixture 至少覆盖函数、类、导出、嵌套和注释误报场景。

### Phase 4：Git 事实层

- 解析 changed files、rename、hunks、增删行。
- 支持 working tree、base ref 和两 commit 模式。
- 实现 `--git`，为 change-impact 提供稳定输入。

验收：新增、删除、修改、重命名、二进制文件和未跟踪文件均有明确状态。

### Phase 5：库化、插件化和兼容迁移

- 发布 ESM 库接口和 CLI。
- 添加 DSH bundle、技能和文档。
- 为 `arch-doc` 和 `dsh-refactor-insight` 提供兼容适配层。
- 发布 npm 和 GitHub tag，补充 dsh-index 元数据。

验收：插件安装后技能可见；两个现有插件在真实 fixture 上输出等价结果；`npm pack --dry-run` 内容完整。

## 9. 测试计划

### 单元测试

- 路径规范化和越界保护。
- 排除目录和最大深度。
- 编码、BOM、超大文件、空文件。
- manifest 版本解析。
- import/require/include 解析。
- Git status 和 hunk 解析。

### 契约测试

使用 `node:test`，直接执行 CLI 并解析 JSON：

- 缺参数和不存在路径退出码。
- `probe` 字段完整。
- `scan` 模块路径稳定。
- `deps` 内外部依赖分类正确。
- `entry` 运行命令来源正确。
- `symbols` 行号和名称正确。
- `all` 输出符合 schema。

### 跨平台测试

- Node 18、20、22（独立扫描器回归矩阵）；DSH 0.1.2-rc.1 宿主另以 Node 22.12 执行 compat。
- Windows 和 Ubuntu GitHub Actions。
- Windows 反斜杠、UTF-8 BOM、CRLF。
- 路径含空格和非 ASCII 字符。

### 性能测试

准备 100、2000、10000 文件 fixture，记录：

- 扫描总耗时。
- 峰值内存。
- 截断是否按规则发生。
- JSON 输出体积。

## 10. 文档和发布

README 必须包含：

- 一句话定位。
- CLI 快速开始。
- JSON 输出样例。
- 参数和退出码。
- 安全红线。
- 与 `arch-doc`、`dsh-refactor-insight` 的关系。
- 迁移示例。

发布前检查：

- `node --test` 全绿。
- 所有 `.mjs`、`plugin/index.js` 通过 `node --check`。
- `npm pack --dry-run` 包含 `src`、`bin`、`plugin`、`skills`、`docs`。
- 任意临时项目 `npm install dsh-repo-scanner` 后，`import { scanRepository }` 与 `bin` 命令均可正常解析执行。
- schema 文档与实际输出一致。
- 真实仓库只读验证通过。
- 版本、CHANGELOG、README 和 dsh-index 信息同步。

## 11. 后续路线

### v0.2

- 增量扫描缓存，按文件 mtime/size/hash 失效。
- 更可靠的 TS/JS import alias 解析。
- OpenAPI、GraphQL、数据库迁移文件识别。
- 更丰富的符号查询：按名称、文件和模块过滤。

### v0.3

- 可插拔解析器接口，允许 Tree-sitter 等可选依赖。
- 生成模块级调用图和符号级引用图。
- 统一 `dsh-analysis-schema`，让多个分析插件共享报告结构。

### v1.0

- 稳定 schema 和兼容策略。
- 大仓库增量索引。
- 明确的性能预算和安全审计。
- 为变更影响、测试洞察、文档同步提供完整事实 API。

## 12. Definition of Done

- [x] 仓库可安装为 DSH 插件。（2026-09-02 已按现行 bundle 契约对齐：`dsh.bundle.patch` + `- insert:` manifest + FileSystemSkillProvider 入口 + 技能 frontmatter；真机 `dsh plugin add` 待发布后回归）
- [ ] DSH 0.1.2-rc.1 compat：`dsh plugin add`、`--dump-config`、有限时长启动通过；不改变 `schema_version`。
- [x] CLI 支持 `probe/scan/deps/entry/symbols/git/all`。
- [x] 输出包含 schema 版本、限制信息、证据和风险。
- [x] 不修改目标仓库、不执行目标代码。
- [x] Python、Node、Go、monorepo fixture 测试通过。
- [x] Windows + Ubuntu CI 通过。（CI 已配置并在每次 push 运行，2026-09-02 起多次全绿）
- [ ] `arch-doc` 和 `dsh-refactor-insight` 可通过适配层复用。（后续迁移轮次）
- [x] 文档、样例、CHANGELOG 和发布包一致。
