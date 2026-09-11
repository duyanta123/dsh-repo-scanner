# dsh-repo-scanner

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c1d95)](https://github.com/topics/dsh-plugin)
[![CI](https://github.com/duyanta123/dsh-repo-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/duyanta123/dsh-repo-scanner/actions/workflows/ci.yml)
[![npm](https://img.shields.io/badge/npm-dsh--repo--scanner-blue)](https://www.npmjs.com/package/dsh-repo-scanner)
[![version](https://img.shields.io/badge/version-0.1.2-green)](CHANGELOG.md)

A unified, reproducible, read-only repository fact-scanning kernel for DeepSeek Harness analysis plugins (npm package name matches the repository name: `dsh-repo-scanner`).

Read-only: never modifies the target repository, never installs dependencies, never executes project code.

## Positioning

dsh-repo-scanner is a shared kernel: it implements "repository → structured facts" once so analysis plugins can reuse it. It serves `arch-doc`, `dsh-refactor-insight`, and `dsh-test-insight` (released) as well as the planned `dsh-change-impact`.

It answers:
- What kind of project is this (language / framework / repo type)?
- What files, modules, symbols, and entry points exist?
- How do internal and external dependencies relate, and are there cycles?
- Which files and modules does a Git change touch (read-only queries)?
- Change impact, test↔source mapping, and stale doc references (facts API)?

Boundaries: a read-only kernel that draws no analytical conclusions (that is the calling plugins' job); its `schema_version` / `analysis_schema` are independent of the DSH host version, so host upgrades do not change the schema.

## Installation

As a DSH plugin (the package follows the DSH bundle spec — `package.json` declares `dsh.bundle.patch` — and registers the `repo-scanner-runbook` skill on install):

```sh
dsh plugin --profile web add "github:duyanta123/dsh-repo-scanner#v0.1.2"
```

Or from npm (as a library or standalone CLI):

```sh
npm install dsh-repo-scanner
```

Compatibility tiers: the library interface and CLI run standalone on Node.js >= 18 (the existing Node 18/20/22 CI is the standalone scanner regression matrix); as a DSH 0.1.5-rc.2 host plugin it requires Node.js >= 22.19. Run `npm run test:compat` to complete an isolated-profile install, config dump, and startup smoke test.

After installing, restart `dsh --profile web` and the skill becomes discoverable; the skill loads its runbook only when needed — scanning itself happens through shell calls to the CLI. Higher-level plugins depend on this package as a library and import the scanning kernel via the exports subpath `dsh-repo-scanner/scanner`.

## Quick Start

### 1. Use as a standalone CLI

```bash
node bin/repo-scanner.mjs <repo_path> --probe
node bin/repo-scanner.mjs <repo_path> --files
node bin/repo-scanner.mjs <repo_path> --scan
node bin/repo-scanner.mjs <repo_path> --deps
node bin/repo-scanner.mjs <repo_path> --entry
node bin/repo-scanner.mjs <repo_path> --symbols
node bin/repo-scanner.mjs <repo_path> --graphs
node bin/repo-scanner.mjs <repo_path> --git --diff-text-file diff.txt
node bin/repo-scanner.mjs <repo_path> --all --json
```

### 2. Use as a library (higher-level plugins)

```js
import { scanRepository } from 'dsh-repo-scanner/scanner';

const report = await scanRepository({
  repoPath: '.',
  modes: ['probe', 'modules', 'dependencies', 'entries', 'symbols', 'graphs', 'git'],
  maxDepth: 3,
  cache: true,                 // incremental scan cache
  parsers: ['heuristic'],      // pluggable parsers (tree-sitter is optional)
  symbolQuery: { name: 'auth' }, // symbol query
  git: { diffText },
});
```

### 3. Facts API (for analysis plugins)

```js
import {
  getChangeImpactFacts, // change impact: reverse-dependency propagation + affected modules/symbols
  getTestInsightFacts,  // test insight: test↔source mapping + module coverage
  getDocSyncFacts,      // doc sync: doc references + stale references
} from 'dsh-repo-scanner/scanner';

const impact = await getChangeImpactFacts({
  repoPath: '.',
  git: { statusText }, // or diffText / changedFiles
});
```

## CLI Options

| Option | Default | Description |
| --- | --- | --- |
| `--max-depth N` | 3 | Maximum directory depth |
| `--max-files N` | 2000 | Maximum file count |
| `--max-file-bytes N` | 256000 | Per-file content read limit |
| `--include-dirs a,b` | empty | Scan only these directories |
| `--exclude-dirs a,b` | built-in | Extra excluded directories |
| `--language LANG` | empty | Language filter |
| `--format json\|jsonl` | json | Output format |
| `--hash` | off | Compute file sha256 (over raw bytes) |
| `--strict` | off | Non-zero exit when errors or warnings exist |
| `--follow-symlinks` | off | Follow symlinks (target must stay inside the repo) |
| `--cache` / `--cache-dir DIR` | off | Incremental scan cache (writes to temp dirs only) |
| `--parsers a,b` | heuristic | Symbol parser chain (tree-sitter optional, auto-fallback when missing) |
| `--symbol-name/file/module` | empty | Symbol query filters |
| `--perf-budget-ms N` | 60000 | Performance budget (0 disables; overrun writes a warning) |

Exit codes: `0` success; `1` errors present, or warnings present under `--strict`; `2` bad arguments or invalid repo path; `3` output failure or contract violation.

## Output

```json
{
  "schema_version": "1.0",
  "analysis_schema": { "name": "dsh-analysis-schema", "version": "1.0" },
  "tool": { "name": "dsh-repo-scanner", "version": "0.1.2" },
  "input": { "repo_path": ".", "resolved_path": "C:/work/app", "options": {} },
  "limits": { "max_depth": 3, "max_files": 2000, "max_file_bytes": 256000, "truncated": false, "warnings": [] },
  "project": {},
  "files": [],
  "modules": [],
  "dependencies": { "internal": [], "external": [] },
  "entry_points": [],
  "run_methods": [],
  "symbols": [],
  "graphs": null,
  "risks": [],
  "errors": [],
  "performance": null,
  "git": null
}
```

Full field reference: [docs/output-schema.md](docs/output-schema.md).

## Safety Red Lines

- Never writes to the target repository; no checkout/reset/clean.
- Never installs dependencies or executes target project code or scripts.
- Refuses out-of-bounds paths after normalization; symlinks not followed by default.
- Never spawns subprocesses to obtain file or Git facts (enforced by executable security audit tests).
- Only imports resolvable inside the repo are classified internal; dynamic import/require goes to `risks`.
- Output auto-redacts tokens, passwords, connection strings, and JWTs.

## Relationship to arch-doc / dsh-refactor-insight

Both plugins currently ship their own `arch-profile.mjs`. This package extracts that scanning logic so they can reuse it via an npm dependency or the CLI; see [docs/migration-guide.md](docs/migration-guide.md) for the planned migration order and field mapping (planned, not yet executed).

## Documentation

- [docs/output-schema.md](docs/output-schema.md) — output JSON contract (`schema_version 1.0`, full field tables)
- [docs/scanning-rules.md](docs/scanning-rules.md) — scanning rules (directory safety, language detection, module detection, dependency resolution, pluggable parsers, cache, performance budget, security audit)
- [docs/migration-guide.md](docs/migration-guide.md) — plan for migrating analysis plugins onto the shared kernel
- [examples/](examples/README.md) — output examples
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [PLUGIN-MAINTENANCE.md](PLUGIN-MAINTENANCE.md) — repo maintenance runbook

## License

[MIT](./LICENSE)
