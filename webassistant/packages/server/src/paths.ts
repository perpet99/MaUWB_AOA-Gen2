/**
 * Where relative paths point.
 *
 * Captures, CSV logs and `file://` specs are typed by a user who is thinking
 * about the repository, not about which directory npm happened to pick as the
 * cwd -- `npm start` runs in `packages/server`, `node packages/server/dist`
 * runs in the workspace root, and a path typed into the browser has no cwd at
 * all. Resolving every one of them against a single root makes those three
 * entry points agree.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The `webassistant/` directory: two levels up from `packages/server`, whether
 * this module is running from `src/` (tsx) or `dist/` (built).
 */
export const DATA_ROOT = process.env.MAUWB_DATA_ROOT
  ? path.resolve(process.env.MAUWB_DATA_ROOT)
  : path.resolve(HERE, '../../..');

/** Resolve a user-supplied path against `DATA_ROOT`, leaving absolute ones alone. */
export function resolveDataPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(DATA_ROOT, p);
}

/** Render a path for display, relative to `DATA_ROOT` when it sits underneath. */
export function displayPath(p: string): string {
  const rel = path.relative(DATA_ROOT, p);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : p;
}
