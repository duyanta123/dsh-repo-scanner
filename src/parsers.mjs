/**
 * v0.3 可插拔解析器接口。
 *
 * 内置 `heuristic` 解析器（零依赖、正则启发式）。第三方可通过
 * `registerParser` 注册自定义解析器（如 Tree-sitter 适配器）；
 * 请求了未注册/未安装的解析器时自动回退 heuristic 并写入 warnings。
 *
 * 解析器契约：
 *   {
 *     name: string,
 *     languages: string[] | null,   // null 表示支持所有语言
 *     extractFile(file, context) => symbol[]  // 同步提取单个文件的符号
 *   }
 */

const registry = new Map();

export function registerParser(name, parser) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('parser name must be a non-empty string');
  }
  if (!parser || typeof parser.extractFile !== 'function') {
    throw new TypeError(`parser "${name}" must provide extractFile(file, context)`);
  }
  const key = name.trim().toLowerCase();
  registry.set(key, {
    name: key,
    languages: Array.isArray(parser.languages) ? new Set(parser.languages) : null,
    extractFile: parser.extractFile,
  });
  return true;
}

export function getParser(name) {
  return registry.get(String(name).trim().toLowerCase()) || null;
}

export function listParsers() {
  return [...registry.keys()];
}

export function parserSupports(parser, language) {
  if (!parser) return false;
  if (!parser.languages) return true;
  return parser.languages.has(language);
}

/**
 * 解析请求的解析器链。不可用的解析器记录警告并跳过；
 * 全部不可用时回退 heuristic。
 */
export function resolveParserChain(requested, warnings) {
  const chain = [];
  const names = Array.isArray(requested) && requested.length > 0 ? requested : ['heuristic'];
  for (const name of names) {
    const parser = getParser(name);
    if (parser) {
      chain.push(parser);
      continue;
    }
    warnings.push({
      code: 'E_PARSER_UNAVAILABLE',
      message: `parser "${name}" is not available; falling back to heuristic`,
    });
  }
  if (chain.length === 0) chain.push(getParser('heuristic'));
  return chain;
}

/**
 * 尝试加载可选的 Tree-sitter 适配器。
 *
 * 零依赖原则下 Tree-sitter 是可选依赖：只有当宿主安装了
 * `tree-sitter` 与对应语言 grammar 时才会注册成功，否则返回 false。
 */
export async function tryRegisterTreeSitter() {
  if (getParser('tree-sitter')) return true;
  let Parser;
  try {
    ({ default: Parser } = await import('tree-sitter'));
  } catch {
    return false;
  }
  const grammars = {
    javascript: 'tree-sitter-javascript',
    typescript: 'tree-sitter-typescript',
    python: 'tree-sitter-python',
    go: 'tree-sitter-go',
  };
  const loaded = {};
  for (const [language, moduleName] of Object.entries(grammars)) {
    try {
      loaded[language] = (await import(moduleName)).default;
    } catch {
      // 该语言 grammar 未安装则跳过该语言。
    }
  }
  if (Object.keys(loaded).length === 0) return false;
  registerParser('tree-sitter', {
    languages: Object.keys(loaded),
    extractFile: (file, context) => extractWithTreeSitter(file, Parser, loaded, context),
  });
  return true;
}

function extractWithTreeSitter(file, Parser, grammars, context) {
  const text = file?._text;
  if (text == null) return [];
  const grammar = grammars[file.language];
  if (!grammar) return [];
  const symbols = [];
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(text);
  walkTree(tree.rootNode, file, symbols);
  return symbols;
}

const TREE_SITTER_KINDS = new Map([
  ['function_declaration', 'function'],
  ['function_definition', 'function'],
  ['method_definition', 'method'],
  ['method_declaration', 'method'],
  ['class_declaration', 'class'],
  ['class_definition', 'class'],
  ['abstract_class_declaration', 'class'],
  ['interface_declaration', 'interface'],
]);

function walkTree(node, file, symbols) {
  if (node.isNamed && TREE_SITTER_KINDS.has(node.type)) {
    const nameNode = node.childForFieldName('name');
    const kind = TREE_SITTER_KINDS.get(node.type);
    if (nameNode) {
      symbols.push({
        name: textOfNode(nameNode),
        kind,
        path: file.path,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        language: file.language,
        visibility: 'module',
        confidence: 'high',
      });
    }
  }
  for (let i = 0; i < node.childCount; i += 1) {
    walkTree(node.child(i), file, symbols);
  }
}

function textOfNode(node) {
  try {
    return node.text;
  } catch {
    return null;
  }
}
