import { registerParser, resolveParserChain, parserSupports, tryRegisterTreeSitter } from './parsers.mjs';

function textOf(file) {
  return file?._text ?? null;
}

/**
 * 轻量级符号索引：内置启发式解析器（正则），可通过 parsers 选项切换
 * 可插拔解析器（v0.3）。无法可靠解析时宁可不返回范围，也不返回
 * 伪精确的 end_line。
 */
export async function extractSymbols(files, context = {}) {
  const options = context.options || {};
  const requested = Array.isArray(options.parsers) && options.parsers.length > 0
    ? options.parsers
    : ['heuristic'];
  const warnings = context.warnings || [];

  // Tree-sitter 属于可选依赖：请求时先尝试注册，失败则回退 heuristic。
  if (requested.includes('tree-sitter') && !tryRegisterTreeSitter.name) {
    // unreachable; 保留可读性
  }
  if (requested.includes('tree-sitter')) {
    const registered = await tryRegisterTreeSitter();
    if (!registered) {
      warnings.push({
        code: 'E_PARSER_UNAVAILABLE',
        message: 'tree-sitter is not installed (optional dependency); falling back to heuristic',
      });
    }
  }

  const chain = resolveParserChain(requested, warnings);
  const cache = context.cache || null;
  const symbols = [];

  for (const file of files) {
    if (!file.language || (file.kind !== 'source' && file.kind !== 'test')) continue;
    const parser = chain.find((p) => parserSupports(p, file.language));
    if (!parser) continue;

    // v1.0 增量索引：文件未变化时直接复用缓存的符号结果。
    let fileSymbols = null;
    const entry = cache?.get(file.path) || null;
    if (entry?.symbols && entry.symbols.parser === parser.name) {
      fileSymbols = entry.symbols.list;
    }
    if (fileSymbols == null) {
      fileSymbols = parser.extractFile(file, context) || [];
      if (cache) {
        cache.set(file.path, {
          ...(entry || {}),
          symbols: { parser: parser.name, list: fileSymbols },
        });
      }
    }
    for (const symbol of fileSymbols) {
      symbols.push({ ...symbol, parser: parser.name });
    }
  }

  return symbols.sort((a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line);
}

/**
 * v0.2 符号查询：按名称（不区分大小写子串）、文件（精确或后缀匹配）、
 * 模块（模块路径/名称匹配，符号路径落在模块目录内）过滤。
 */
export function querySymbols(symbols, query = {}, modules = []) {
  const name = query.name != null ? String(query.name).trim().toLowerCase() : null;
  const file = query.file != null ? String(query.file).trim() : null;
  const module = query.module != null ? String(query.module).trim() : null;
  if (!name && !file && !module) return [...symbols];

  let modulePaths = null;
  if (module) {
    modulePaths = new Set(
      modules
        .filter((m) => m.path === module || m.name === module)
        .map((m) => m.path),
    );
  }

  return symbols.filter((symbol) => {
    if (name && !String(symbol.name || '').toLowerCase().includes(name)) return false;
    if (file) {
      const posix = String(symbol.path || '');
      if (posix !== file && !posix.endsWith(`/${file}`)) return false;
    }
    if (modulePaths) {
      if (modulePaths.size === 0) return false;
      const posix = String(symbol.path || '');
      const matched = [...modulePaths].some((m) => posix === m || posix.startsWith(`${m}/`));
      if (!matched) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 内置 heuristic 解析器
// ---------------------------------------------------------------------------

const heuristicParser = {
  name: 'heuristic',
  languages: null,
  extractFile(file) {
    const text = textOf(file);
    if (text == null) return [];
    const lines = text.split(/\r?\n/);
    const symbols = [];
    if (file.language === 'javascript' || file.language === 'typescript') {
      extractJsSymbols(file.path, lines, symbols);
    } else if (file.language === 'python') {
      extractPythonSymbols(file.path, lines, symbols);
    } else if (file.language === 'go') {
      extractGoSymbols(file.path, lines, symbols);
    } else if (file.language === 'java' || file.language === 'kotlin') {
      extractJavaSymbols(file.path, lines, symbols);
    }
    return symbols;
  },
};

registerParser('heuristic', heuristicParser);

function pushSymbol(symbols, symbol) {
  if (!symbol.name) return;
  symbols.push({
    ...symbol,
    confidence: symbol.confidence || 'medium',
  });
}

function extractJsSymbols(filePath, lines, symbols) {
  const language = jsLanguageOf(filePath);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const source = stripJsComments(line);

    let match = source.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (match) {
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name: match[1],
        kind: 'function',
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language,
        visibility: line.includes('export') ? 'exported' : 'module',
      });
      addJsExportIfNeeded(filePath, line, match[1], i + 1, symbols);
      continue;
    }

    match = source.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (match) {
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name: match[1],
        kind: 'class',
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language,
        visibility: line.includes('export') ? 'exported' : 'module',
      });
      addJsExportIfNeeded(filePath, line, match[1], i + 1, symbols);
      continue;
    }

    match = source.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/);
    if (!match) match = source.match(/^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/);
    if (match) {
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name: match[1],
        kind: 'function',
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language,
        visibility: line.includes('export') ? 'exported' : 'const',
      });
      addJsExportIfNeeded(filePath, line, match[1], i + 1, symbols);
      continue;
    }

    // export { a, b as c } / export { a as default }
    match = source.match(/^\s*export\s*\{([^}]*)\}/);
    if (match) {
      for (const part of match[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const asMatch = trimmed.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*|default)$/);
        const exportedName = asMatch ? asMatch[2] : trimmed.split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (exportedName) {
          pushSymbol(symbols, {
            name: exportedName,
            kind: 'export',
            path: filePath,
            start_line: i + 1,
            end_line: i + 1,
            language,
            visibility: 'exported',
            confidence: 'high',
          });
        }
      }
      continue;
    }

    // 类方法（缩进 >= 2，行尾直接跟 `{`；这是启发式，confidence=low/medium）
    match = source.match(/^\s{2,}((?:public|private|protected|async|static|get|set)\s+)+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/);
    if (match) {
      const name = match[2];
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name,
        kind: 'method',
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language,
        visibility: /private/.test(line) ? 'private' : /public/.test(line) ? 'public' : 'class',
        confidence: 'low',
      });
    }
  }
}

function jsLanguageOf(filePath) {
  return /\.(ts|mts|cts|tsx)$/.test(filePath) ? 'typescript' : 'javascript';
}

function addJsExportIfNeeded(filePath, line, name, startLine, symbols) {
  if (/\bexport\b/.test(line) && !line.includes('export default')) {
    pushSymbol(symbols, { name, kind: 'export', path: filePath, start_line: startLine, end_line: startLine, language: jsLanguageOf(filePath), visibility: 'exported', confidence: 'high' });
  } else if (line.includes('export default')) {
    pushSymbol(symbols, { name: 'default', kind: 'export', path: filePath, start_line: startLine, end_line: startLine, language: jsLanguageOf(filePath), visibility: 'exported', confidence: 'high' });
  }
}

function extractPythonSymbols(filePath, lines, symbols) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = line.match(/^(\s*)(?:def|class)\s+([A-Za-z_][\w]*)\s*(\(|:)/);
    if (!match) continue;
    const indent = match[1].length;
    const kind = match[0].trim().startsWith('class') ? 'class' : (indent > 0 ? 'method' : 'function');
    const end = findPythonBlockEnd(lines, i, indent);
    const name = match[2];
    pushSymbol(symbols, {
      name,
      kind,
      path: filePath,
      start_line: i + 1,
      end_line: end,
      language: 'python',
      visibility: name.startsWith('__') ? 'private' : name.startsWith('_') ? 'protected' : 'public',
    });
  }

  // __all__ 文件级导出列表
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^__all__\s*=\s*\[([^\]]*)\]/);
    if (match) {
      for (const item of match[1].split(',')) {
        const name = item.trim().replace(/^["']|["']$/g, '');
        if (name) pushSymbol(symbols, { name, kind: 'export', path: filePath, start_line: i + 1, end_line: i + 1, language: 'python', visibility: 'exported', confidence: 'high' });
      }
    }
  }
}

function extractGoSymbols(filePath, lines, symbols) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripLineComments(lines[i]);
    let match = line.match(/^func\s+(\(([^)]*)\)\s+)?([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      const name = match[3];
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name,
        kind: match[2] ? 'method' : 'function',
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language: 'go',
        visibility: /^[A-Z]/.test(name) ? 'exported' : 'package',
      });
      continue;
    }
    match = line.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\s*\{?/);
    if (match) {
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name: match[1],
        kind: match[2],
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language: 'go',
        visibility: /^[A-Z]/.test(match[1]) ? 'exported' : 'package',
      });
    }
  }
}

function extractJavaSymbols(filePath, lines, symbols) {
  const language = /\.kt$/.test(filePath) ? 'kotlin' : 'java';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    let match = line.match(/^(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+)*?(class|interface|enum)\s+([A-Za-z_][\w]*)/);
    if (match) {
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name: match[2],
        kind: match[1],
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language,
        visibility: line.includes('private') ? 'private' : line.includes('protected') ? 'protected' : 'public',
        confidence: 'high',
      });
      continue;
    }
    match = line.match(/^(public\s+|protected\s+|private\s+)*(?:static\s+)*(?:synchronized\s+)*[A-Za-z_][\w<>\[\],\s]*\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/);
    if (match) {
      const end = findBraceBlockEnd(lines, i);
      pushSymbol(symbols, {
        name: match[2],
        kind: 'method',
        path: filePath,
        start_line: i + 1,
        end_line: end,
        language,
        visibility: line.includes('private') ? 'private' : line.includes('protected') ? 'protected' : 'public',
        confidence: 'low',
      });
    }
  }
}

function stripJsComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

function stripLineComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

function findBraceBlockEnd(lines, startIndex) {
  let started = false;
  let depth = 0;
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        // 跳过字符串字面量
        const quote = ch;
        j += 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === '\\') j += 1;
          j += 1;
        }
        continue;
      }
      if (ch === '{') {
        started = true;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth <= 0) return i + 1;
      }
    }
  }
  return lines.length;
}

function findPythonBlockEnd(lines, startIndex, baseIndent) {
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) return i; // 1-based end line（前一非空行行号）
  }
  return lines.length;
}
