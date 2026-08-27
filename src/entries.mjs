import path from 'node:path';

function textOf(file) {
  return file?._text ?? null;
}

function tryJson(text) {
  try {
    return JSON.parse(text || 'null');
  } catch {
    return null;
  }
}

/**
 * 识别入口和运行方式。输出事实（路径、行号、来源）和 evidence，不做职责推断。
 */
export function detectEntryPoints(files, context = {}) {
  const entryPoints = [];
  const runMethods = [];
  const fileIndex = new Map(files.map((f) => [f.path, f]));

  collectNodeEntries(files, fileIndex, entryPoints, runMethods);
  collectPythonEntries(files, entryPoints, runMethods);
  collectGoEntries(files, entryPoints, runMethods);
  collectJavaEntries(files, entryPoints);
  collectMakefileRunMethods(files, runMethods);
  collectDockerfileRunMethods(files, runMethods);
  collectReadmeCommands(files, runMethods);

  return {
    entry_points: dedupeByKey(entryPoints, (e) => `${e.type}|${e.path || ''}|${e.evidence.join(',')}`),
    run_methods: dedupeByKey(runMethods, (r) => `${r.source}|${r.command}|${r.type || ''}`),
  };
}

function collectNodeEntries(files, fileIndex, entryPoints, runMethods) {
  const packageJsonFile = fileIndex.get('package.json');
  const packageJson = packageJsonFile ? tryJson(textOf(packageJsonFile)) : null;

  if (packageJson?.bin) {
    const bin = packageJson.bin;
    const entries = typeof bin === 'string' ? { [packageJson.name || 'cli']: bin } : bin;
    for (const [name, target] of Object.entries(entries)) {
      const entryPath = normalizePath(target);
      if (fileIndex.has(entryPath)) {
        entryPoints.push({ type: 'cli', name, path: entryPath, line: 1, evidence: ['package.json#bin'], confidence: 'high' });
      }
    }
  }

  if (packageJson?.scripts) {
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      runMethods.push({ name, command: String(command), source: 'package.json', type: 'script', line: null, confidence: 'high' });
    }
  }

  if (packageJson && !packageJson.bin && (packageJson.main || packageJson.module || packageJson.exports)) {
    const entryPath = normalizePath(packageJson.main || packageJson.module || (typeof packageJson.exports === 'string' ? packageJson.exports : null));
    if (entryPath && fileIndex.has(entryPath)) {
      entryPoints.push({ type: 'library', name: packageJson.name || 'main', path: entryPath, line: 1, evidence: ['package.json main/module/exports'], confidence: 'high' });
    }
  }

  for (const file of files) {
    if (!file.language || (file.language !== 'javascript' && file.language !== 'typescript')) continue;
    const base = file.path.split('/').pop();
    const text = textOf(file);

    if (/^(bin|cmd)\//.test(file.path) || /^(cli|main)\.(js|ts|mjs|mts|cts|tsx)$/i.test(base)) {
      if (!entryPoints.some((e) => e.path === file.path)) {
        entryPoints.push({ type: 'cli', path: file.path, line: 1, evidence: ['cli path convention'], confidence: 'medium' });
      }
    }
    if (text) {
      const ev = [];
      if (/FastAPI|fastapi|Flask|flask|express\s*\(|express\./.test(text)) ev.push('web framework call');
      if (/createServer\s*\(/.test(text)) ev.push('http.createServer');
      if (/new\s+Worker\s*\(/.test(text) || /BullMQ|bullmq|RabbitMQ|amqplib/.test(text)) ev.push('worker/queue API');
      if (/schedule|scheduler|cron/.test(text) && ev.length === 0) ev.push('scheduler API');
      if (ev.length > 0) {
        const type = ev[0].includes('worker') || text.includes('Worker') ? 'worker'
          : ev[0].includes('scheduler') || text.includes('cron') ? 'scheduler'
          : 'web';
        entryPoints.push({ type, path: file.path, line: findFirstMatchLine(text, ev[0]) || 1, evidence: ev, confidence: 'medium' });
      }
    }
  }
}

function collectPythonEntries(files, entryPoints, runMethods) {
  const pyproject = files.find((f) => f.path === 'pyproject.toml');
  if (pyproject) {
    const text = textOf(pyproject) || '';
    const section = text.match(/\[project\.scripts\][\s\S]*?(?=\n\[|$)/);
    if (section) {
      const re = /^\s*([a-zA-Z][\w.-]*)\s*=\s*["']([^"']+)["']/gm;
      let m;
      while ((m = re.exec(section[0])) !== null) {
        runMethods.push({ name: m[1], command: m[2], source: 'pyproject.toml', type: 'script', line: null, confidence: 'high' });
        const moduleParts = m[2].split(':')[0].split('.');
        const possiblePath = `${moduleParts.join('/')}.py`;
        if (files.some((f) => f.path === possiblePath || f.path.endsWith(`/${possiblePath}`))) {
          const path = files.find((f) => f.path === possiblePath || f.path.endsWith(`/${possiblePath}`)).path;
          entryPoints.push({ type: 'cli', name: m[1], path, line: 1, evidence: ['[project.scripts]'], confidence: 'high' });
        }
      }
    }
  }

  for (const file of files) {
    if (file.language !== 'python') continue;
    const base = file.path.split('/').pop();
    if (/^(cli|app|main|run|serve)\.py$|worker|consumer|scheduler|cron/i.test(base) || /^(bin|cmd|scripts)\//.test(file.path)) {
      const type = /worker|consumer|queue/.test(base) ? 'worker' : /scheduler|cron/.test(base) ? 'scheduler' : 'cli';
      entryPoints.push({ type, path: file.path, line: 1, evidence: ['python entry convention'], confidence: 'medium' });
    }
    const text = textOf(file);
    if (text) {
      const ev = [];
      if (/argparse/.test(text)) ev.push('argparse');
      if (/FastAPI|fastapi|Flask|flask|Django|django/.test(text)) ev.push('web framework');
      if (/Celery|celery/.test(text)) ev.push('Celery');
      if (ev.length > 0) {
        const type = ev.some((x) => /Celery/.test(x)) ? 'worker'
          : ev.some((x) => /FastAPI|Flask|Django/.test(x)) ? 'web'
          : 'cli';
        const existing = entryPoints.find((e) => e.path === file.path);
        if (existing) existing.evidence = [...new Set([...existing.evidence, ...ev])];
        else entryPoints.push({ type, path: file.path, line: 1, evidence: ev, confidence: 'medium' });
      }
    }
  }
}

function collectGoEntries(files, entryPoints) {
  for (const file of files) {
    if (file.language !== 'go') continue;
    const inCmd = file.path.startsWith('cmd/');
    const base = file.path.split('/').pop();
    const text = textOf(file) || '';
    const ev = [];
    if (inCmd || /^main\.go$/.test(base)) ev.push('go command convention');
    if (/http\.ListenAndServe|gorilla\/mux|gin\.|fiber\./.test(text)) ev.push('go http server');
    if (/cobra|urfave\/cli|kingpin/.test(text)) ev.push('go cli framework');
    if (/cron|scheduler|worker|queue/.test(text)) ev.push('go worker/scheduler API');
    if (ev.length === 0) continue;
    const type = ev.some((x) => /http|gin|fiber|mux/.test(x)) ? 'web'
      : ev.some((x) => /cron|scheduler|worker|queue/.test(x)) ? (text.includes('cron') ? 'scheduler' : 'worker')
      : 'cli';
    entryPoints.push({ type, path: file.path, line: 1, evidence: ev, confidence: 'medium' });
  }
}

function collectJavaEntries(files, entryPoints) {
  for (const file of files) {
    if (file.language !== 'java' && file.language !== 'kotlin') continue;
    const text = textOf(file) || '';
    const base = file.path.split('/').pop();
    const ev = [];
    if (/@SpringBootApplication/.test(text)) ev.push('Spring Boot application');
    if (/public\s+static\s+void\s+main\s*\(/.test(text)) ev.push('Java main method');
    if (ev.length > 0) {
      const type = ev.some((x) => /Spring/.test(x)) || /Controller|RestController/.test(text) ? 'web' : 'cli';
      entryPoints.push({ type, path: file.path, line: findFirstMatchLine(text, ev[0]) || 1, evidence: ev, confidence: 'high' });
    }
  }
}

function collectMakefileRunMethods(files, runMethods) {
  const makefile = files.find((f) => /^(GNUmakefile|makefile|Makefile)$/.test(f.path));
  if (!makefile) return;
  const text = textOf(makefile) || '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:\s*(?:[^=]|$)/);
    if (match && /^[a-zA-Z_][a-zA-Z0-9_.-]*\s*:/.test(lines[i]) && !lines[i].includes('::')) {
      runMethods.push({ name: match[1], command: `make ${match[1]}`, source: 'makefile', type: 'make-target', line: i + 1, confidence: 'high' });
    }
  }
}

function collectDockerfileRunMethods(files, runMethods) {
  for (const file of files) {
    const base = file.path.split('/').pop().toLowerCase();
    if (base !== 'dockerfile' && !base.startsWith('dockerfile.') && !/^compose[^/]*\.(yaml|yml)$/i.test(base) && !/^docker-compose/i.test(base)) continue;
    const text = textOf(file) || '';
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^(CMD|ENTRYPOINT)\s+(.+)$/i);
      if (match) {
        runMethods.push({ name: match[1].toLowerCase(), command: match[2].trim(), source: file.path, type: 'docker', line: i + 1, confidence: 'high' });
      }
    }
  }
}

function collectReadmeCommands(files, runMethods) {
  for (const file of files) {
    if (!/^(readme|docs\/.*\.md|.*\.md)$/i.test(file.path)) continue;
    const base = file.path.split('/').pop().toLowerCase();
    if (!/^(readme\.md|readme\.markdown|README\.md|README)$/.test(base)) continue;
    const text = textOf(file) || '';
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^\s{0,3}(?:`+)?\s*\$?\s*(npm\s+(?:run\s+|test|start|build|install)|pip\s+install|python\s+[^\s]+|go\s+(build|run|test)|make\s+[a-zA-Z0-9_.-]+)\s*`*$/);
      if (match) {
        runMethods.push({ name: match[1].trim(), command: match[1].trim(), source: 'readme', type: 'command', line: i + 1, confidence: 'medium' });
      }
    }
  }
}

function findFirstMatchLine(text, needle) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return null;
}

function normalizePath(value) {
  if (!value) return null;
  return String(value).replace(/\\/g, '/').replace(/^\.\/?/, '');
}

function dedupeByKey(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => (a.path || '').localeCompare(b.path || '') || (a.command || '').localeCompare(b.command || ''));
}