/**
 * dsh-repo-scanner 错误与警告类型。
 * 保持零运行依赖：仅继承 Error。
 */

export class RepoScannerError extends Error {
  constructor(message, code = 'E_SCANNER', details = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== null) this.details = details;
  }
}

export class InvalidRepoPathError extends RepoScannerError {
  constructor(repoPath, reason = 'repository path is invalid') {
    super(`${reason}: ${repoPath}`, 'E_INVALID_REPO_PATH', { repoPath });
  }
}

export class PathTraversalError extends RepoScannerError {
  constructor(candidate, reason = 'path escapes repository boundary') {
    super(`${reason}: ${candidate}`, 'E_PATH_TRAVERSAL', { candidate });
  }
}

export class OutputValidationError extends RepoScannerError {
  constructor(message, details = null) {
    super(message, 'E_OUTPUT_VALIDATION', details);
  }
}

export class ReadFailureWarning {
  constructor(path, message, code = 'E_READ_FAILED') {
    this.path = path;
    this.message = message;
    this.code = code;
  }
}

export function isRepoScannerError(value) {
  return value instanceof RepoScannerError;
}