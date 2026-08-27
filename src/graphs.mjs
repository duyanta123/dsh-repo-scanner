import { resolveImportTarget } from './dependencies.mjs';

/**
 * v0.3 图分析：
 * - module_call_graph：模块级调用图，边 = 内部依赖聚合到模块维度。
 * - symbol_references：符号级引用图，把命名导入绑定解析到目标文件的导出符号。
 *
 * 只输出可解析的事实边；无法确认的绑定不强行猜测。
 */
export function buildGraphs({ files, modules, internal, symbols }) {
  return {
    module_call_graph: buildModuleCallGraph(modules, internal),
    symbol_references: buildSymbolReferenceGraph(files, internal, symbols),
  };
}

function fileToModuleIndex(modules) {
  const map = new Map();
  for (const mod of modules) {
    for (const filePath of mod.file_paths || []) map.set(filePath, mod.path);
  }
  return map;
}

function buildModuleCallGraph(modules, internal) {
  const fileToModule = fileToModuleIndex(modules);
  const nodes = modules.map((m) => ({ name: m.name, path: m.path, file_count: m.file_count }));
  const edgeMap = new Map();

  for (const dep of internal || []) {
    const sourceModule = fileToModule.get(dep.source);
    const targetModule = fileToModule.get(dep.target);
    if (!sourceModule || !targetModule || sourceModule === targetModule) continue;
    const key = `${sourceModule}->${targetModule}`;
    const edge = edgeMap.get(key) || { source: sourceModule, target: targetModule, weight: 0, imports: [] };
    edge.weight += dep.locations?.length || 1;
    edge.imports.push({ source: dep.source, target: dep.target });
    edgeMap.set(key, edge);
  }

  const edges = [...edgeMap.values()]
    .map((edge) => ({ ...edge, imports: edge.imports.sort((a, b) => a.source.localeCompare(b.source)) }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  return { nodes, edges };
}

function buildSymbolReferenceGraph(files, internal, symbols) {
  // 目标文件可被外部引用的符号名集合。
  const exportsByFile = new Map();
  const topLevelsByFile = new Map();
  for (const symbol of symbols || []) {
    if (symbol.kind === 'export') {
      addToFileIndex(exportsByFile, symbol.path, symbol.name);
    }
    if (symbol.kind === 'function' || symbol.kind === 'class' || symbol.kind === 'export') {
      addToFileIndex(topLevelsByFile, symbol.path, symbol.name);
    }
  }

  const seen = new Set();
  const references = [];
  for (const file of files) {
    if (!file._text) continue;
    if (file.language === 'javascript' || file.language === 'typescript') {
      collectJsReferences(file, files, exportsByFile, seen, references);
    } else if (file.language === 'python') {
      collectPythonReferences(file, files, topLevelsByFile, seen, references);
    }
  }
  return references.sort(
    (a, b) => a.source_file.localeCompare(b.source_file) || (a.symbol || '').localeCompare(b.symbol || '') || a.line - b.line,
  );
}

function addToFileIndex(index, filePath, name) {
  if (!filePath || !name) return;
  if (!index.has(filePath)) index.set(filePath, new Set());
  index.get(filePath).add(name);
}

function collectJsReferences(file, files, exportsByFile, seen, references) {
  const text = file._text;
  const importRe = /\bimport\s+([^'"\n]+?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(text)) !== null) {
    const line = countLineAt(text, match.index) + 1;
    const clause = match[1];
    const spec = match[2];
    const target = resolveImportTarget(files, file.path, spec, file.language);
    if (!target) continue;
    const exports = exportsByFile.get(target);

    const named = [...clause.matchAll(/\{([^}]*)\}/g)].flatMap((m) => m[1].split(','));
    for (const raw of named) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // `a as b`：引用的目标符号名是 a。
      const imported = trimmed.split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
      if (!imported) continue;
      pushReference(references, seen, {
        source_file: file.path,
        target_file: target,
        symbol: imported,
        kind: 'named-import',
        line,
        confidence: exports?.has(imported) ? 'high' : 'medium',
      });
    }

    // 默认导入：目标存在 default 导出时记为符号引用，否则记为模块引用。
    const defaultName = clause
      .replace(/\{[^}]*\}/g, '')
      .replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, '')
      .replace(/,/g, '')
      .trim();
    if (defaultName) {
      pushReference(references, seen, {
        source_file: file.path,
        target_file: target,
        symbol: 'default',
        kind: 'default-import',
        line,
        confidence: exports?.has('default') ? 'high' : 'medium',
      });
    }

    // 命名空间导入：引用整个模块。
    const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (nsMatch) {
      pushReference(references, seen, {
        source_file: file.path,
        target_file: target,
        symbol: null,
        kind: 'namespace-import',
        line,
        confidence: 'medium',
      });
    }
  }
}

function collectPythonReferences(file, files, topLevelsByFile, seen, references) {
  const text = file._text;
  const fromRe = /^\s*from\s+([^\s]+)\s+import\s+(.+)$/gm;
  let match;
  while ((match = fromRe.exec(text)) !== null) {
    const line = countLineAt(text, match.index) + 1;
    const spec = match[1];
    const target = resolveImportTarget(files, file.path, spec, file.language);
    if (!target) continue;
    const names = topLevelsByFile.get(target);
    for (const raw of match[2].split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const imported = trimmed.split(/\s+as\s+/)[0].replace(/[()]/g, '').trim();
      if (!imported || imported === '*') {
        pushReference(references, seen, {
          source_file: file.path,
          target_file: target,
          symbol: null,
          kind: 'star-import',
          line,
          confidence: 'low',
        });
        continue;
      }
      pushReference(references, seen, {
        source_file: file.path,
        target_file: target,
        symbol: imported,
        kind: 'from-import',
        line,
        confidence: names?.has(imported) ? 'high' : 'medium',
      });
    }
  }
}

function pushReference(references, seen, ref) {
  const key = `${ref.source_file}|${ref.target_file}|${ref.symbol ?? '*'}|${ref.line}`;
  if (seen.has(key)) return;
  seen.add(key);
  references.push(ref);
}

function countLineAt(text, index) {
  const matches = text.slice(0, index).match(/\n/g);
  return matches ? matches.length : 0;
}
