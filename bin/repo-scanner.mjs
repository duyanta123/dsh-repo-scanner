#!/usr/bin/env node
import fs from 'node:fs';
import { scanRepository, TOOL_NAME, TOOL_VERSION, SCHEMA_VERSION, validateReport, normalizeOptions } from '../src/index.mjs';
import { serializeReport } from '../src/output.mjs';

const USAGE = `dsh-repo-scanner ${TOOL_VERSION}

Usage:
  node bin/repo-scanner.mjs <repo_path> [mode] [options]

Modes:
  --probe      仓库探测：语言、仓库类型、技术栈、manifest
  --files      文件索引
  --scan       模块识别（等价 modes: scan/modules）
  --deps       依赖关系（internal/external）
  --entry      入口与运行方式
  --symbols    符号索引
  --graphs     图分析：模块调用图 + 符号引用图
  --git        Git 事实（HEAD、分支、变更文件；可用 --diff-text-file/--status-text-file 提供只读 diff 文本）
  --all        全部模式（默认）

Options:
  --max-depth N          最大目录深度（默认 3）
  --max-files N          最大文件数（默认 2000）
  --max-file-bytes N     单文件内容读取上限（默认 256000）
  --include-dirs a,b     只扫描这些目录（root 文件始终保留）
  --exclude-dirs a,b     追加排除目录（默认排除 .git/node_modules/dist 等）
  --language LANG        按语言过滤文件
  --format json|jsonl    输出格式（默认 json）
  --hash                 计算文件 sha256
  --strict               输出校验失败、路径越界时非零退出
  --follow-symlinks      跟随符号链接（默认关闭，链接目标必须在仓库内）
  --cache                启用增量扫描缓存（只写系统临时目录）
  --cache-dir DIR        缓存目录（默认 os.tmpdir()/dsh-repo-scanner-cache）
  --parsers a,b          符号解析器（heuristic | tree-sitter；tree-sitter 为可选依赖）
  --symbol-name NAME     符号查询：按名称过滤（不区分大小写子串）
  --symbol-file FILE     符号查询：按文件过滤（精确或后缀匹配）
  --symbol-module NAME   符号查询：按模块过滤（模块路径或名称）
  --perf-budget-ms N     性能预算毫秒数（默认 60000，超限写 warning；0 关闭）
  --base <ref>           Git base ref（记录到 git.compare，供变更影响分析）
  --head <ref>           Git head ref（记录到 git.compare，供变更影响分析）
  --diff-text-file FILE  只读读取 diff 全文（供 --git）
  --status-text-file FILE 只读读取 git status 文本（供 --git）
  --json                 等价 --format json
  --version              打印版本
  --help                 打印帮助
`;

export function parseArgs(argv) {
  const args = [...argv];
  const positional = [];
  const modes = [];
  const options = {};
  let help = false;
  let version = false;

  const readValue = (name, fallback) => {
    if (args.length === 0) {
      throw new Error(`missing value for ${name}`);
    }
    const value = args.shift();
    return value ?? fallback;
  };

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--probe':
        modes.push('probe');
        break;
      case '--files':
        modes.push('files');
        break;
      case '--scan':
        modes.push('scan');
        break;
      case '--deps':
        modes.push('deps');
        break;
      case '--entry':
        modes.push('entry');
        break;
      case '--symbols':
        modes.push('symbols');
        break;
      case '--graphs':
        modes.push('graphs');
        break;
      case '--git':
        modes.push('git');
        break;
      case '--all':
        modes.push('all');
        break;
      case '--max-depth':
        options.maxDepth = readValue('--max-depth');
        break;
      case '--max-files':
        options.maxFiles = readValue('--max-files');
        break;
      case '--max-file-bytes':
        options.maxFileBytes = readValue('--max-file-bytes');
        break;
      case '--include-dirs':
        options.includeDirs = readValue('--include-dirs');
        break;
      case '--exclude-dirs':
        options.excludeDirs = readValue('--exclude-dirs');
        break;
      case '--language':
        options.language = readValue('--language');
        break;
      case '--format':
        options.format = readValue('--format');
        break;
      case '--json':
        options.format = 'json';
        break;
      case '--hash':
        options.hash = true;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--follow-symlinks':
        options.followSymlinks = true;
        break;
      case '--cache':
        options.cache = true;
        break;
      case '--cache-dir':
        options.cacheDir = readValue('--cache-dir');
        break;
      case '--parsers':
        options.parsers = readValue('--parsers');
        break;
      case '--symbol-name':
        options.symbolQuery = options.symbolQuery || {};
        options.symbolQuery.name = readValue('--symbol-name');
        break;
      case '--symbol-file':
        options.symbolQuery = options.symbolQuery || {};
        options.symbolQuery.file = readValue('--symbol-file');
        break;
      case '--symbol-module':
        options.symbolQuery = options.symbolQuery || {};
        options.symbolQuery.module = readValue('--symbol-module');
        break;
      case '--perf-budget-ms':
        options.perfBudgetMs = readValue('--perf-budget-ms');
        break;
      case '--base':
        options.git = options.git || {};
        options.git.base = readValue('--base');
        break;
      case '--head':
        options.git = options.git || {};
        options.git.head = readValue('--head');
        break;
      case '--diff-text-file': {
        const file = readValue('--diff-text-file');
        options.git = options.git || {};
        options.git.diffText = readOwnFile(file);
        break;
      }
      case '--status-text-file': {
        const file = readValue('--status-text-file');
        options.git = options.git || {};
        options.git.statusText = readOwnFile(file);
        break;
      }
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
        version = true;
        break;
      default:
        if (arg.startsWith('--') && arg.includes('=')) {
          const [name, value] = [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
          args.unshift(value);
          args.unshift(name);
          continue;
        }
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        positional.push(arg);
        break;
    }
  }

  return { positional, modes, options, help, version };
}

function readOwnFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read file ${filePath}: ${err.code || err.message}`);
  }
}

function printError(error, exitCode) {
  const payload = {
    schema_version: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    error: {
      code: error.code || 'E_SCANNER',
      message: error.message || String(error),
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    printError(err, 2);
    process.exit(2);
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (parsed.version) {
    process.stdout.write(`${TOOL_NAME} ${TOOL_VERSION}\n`);
    process.exit(0);
  }

  if (parsed.positional.length === 0) {
    printError(new Error('missing <repo_path> argument'), 2);
    process.exit(2);
  }
  if (parsed.positional.length > 1) {
    printError(new Error(`unexpected extra argument: ${parsed.positional[1]}`), 2);
    process.exit(2);
  }

  const input = {
    repoPath: parsed.positional[0],
    modes: parsed.modes.length > 0 ? parsed.modes : ['all'],
    ...parsed.options,
  };

  try {
    const report = await scanRepository(input);
    let output;
    try {
      output = serializeReport(report, parsed.options.format || 'json');
    } catch (validationErr) {
      printError(validationErr, 3);
      process.exit(3);
    }
    process.stdout.write(`${output}\n`);

    const warnings = report.limits?.warnings?.length || 0;
    const errors = report.errors?.length || 0;
    if (warnings > 0 || errors > 0) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    const code = err?.code;
    if (code === 'E_INVALID_REPO_PATH' || code === 'E_PATH_TRAVERSAL') {
      printError(err, 2);
      process.exit(2);
    }
    if (code === 'E_OUTPUT_VALIDATION') {
      printError(err, 3);
      process.exit(3);
    }
    printError(err, 3);
    process.exit(3);
  }
}

await main();