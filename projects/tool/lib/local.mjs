// local.mjs — everything read from projects/local/ (per-machine, ignored by git).
// See local/README.md for the shape of each file.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCAL_DIR } from './paths.mjs';

/**
 * A JSON file from local/, or `fallback` when it is absent or empty. A file
 * that exists but is broken is an error: silently ignoring it would publish
 * wrong owners or show excluded repos.
 */
export function readLocalJson(name, fallback, dir = LOCAL_DIR) {
  const path = join(dir, name);
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return fallback;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`projects/local/${name} is not valid JSON: ${error.message}`);
  }
  const wantArray = Array.isArray(fallback);
  if (Array.isArray(value) !== wantArray || value === null || typeof value !== 'object') {
    throw new Error(`projects/local/${name} must be a JSON ${wantArray ? 'array' : 'object'}`);
  }
  return value;
}

const config = readLocalJson('config.json', {});

/** Owner of repos with no owner folder (Git-clones/). */
export const GITHUB_USER = process.env.AGENTHUB_GITHUB_USER || config.githubUser || 'local-user';
/**
 * Whose commits the activity view counts: `author` in config.json is one email or an
 * array of them (AGENTHUB_AUTHOR: comma-separated). A commit by any of them counts.
 */
const rawAuthors = process.env.AGENTHUB_AUTHOR ? process.env.AGENTHUB_AUTHOR.split(',') : config.author;
export const AUTHORS = (Array.isArray(rawAuthors) ? rawAuthors : [rawAuthors])
  .map((a) => String(a ?? '').trim())
  .filter(Boolean);
if (!AUTHORS.length) AUTHORS.push('local@localhost');
/**
 * Display form, e.g. for "N commits by …": the account name, never an address.
 * `authorName` in config.json overrides it.
 */
export const AUTHOR = config.authorName || config.githubUser || 'local-user';
/** `git log --author` takes a basic regex: escape it so an email matches literally. */
export const authorPattern = (email) => email.replace(/[.*^$[\]\\]/g, '\\$&');
/** Per-repo `owner` / `project` / `working` exceptions, keyed by folder name. */
export const OVERRIDES = readLocalJson('overrides.json', {});
/** Pinned owner avatars, keyed by normalised owner name. */
export const OWNER_ICON_PINS = readLocalJson('icons.json', {});

/** Root-relative paths to leave out of the scan. */
export function readExclusions(dir) {
  const value = readLocalJson('exclusions.json', [], dir);
  if (value.some((entry) => typeof entry !== 'string')) {
    throw new Error('projects/local/exclusions.json must contain only root-relative path strings');
  }
  return value;
}
