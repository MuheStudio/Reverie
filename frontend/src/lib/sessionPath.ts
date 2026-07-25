/**
 * Global session path holder.
 * Set by ChatPanel when character/mod selection changes.
 * Used by diskStorage and file tools to scope all file operations.
 */

let _sessionPath = '';

export function setSessionPath(path: string): void {
  _sessionPath = path;
}

export function getSessionPath(): string {
  return _sessionPath;
}
