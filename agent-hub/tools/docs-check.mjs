#!/usr/bin/env node
// Offline file-link validation for the repository's human documentation.
// Templates contain installation-time paths and are exercised by init tests.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function documentationFiles(root = ROOT) {
  const files = ['README.md', 'AGENTS.md'].map((name) => join(root, name));
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push(path);
    }
  }
  walk(join(root, 'docs'));
  return files.sort();
}

export function checkDocumentation(root = ROOT, files = documentationFiles(root)) {
  const errors = [];
  for (const file of files) {
    if (!existsSync(file)) {
      errors.push(`${relative(root, file)}: file is missing`);
      continue;
    }
    // Do not mistake example links in code blocks for navigation links.
    const text = readFileSync(file, 'utf8')
      .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
      .replace(/`+[^`\n]*`+/g, '');
    for (const match of text.matchAll(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('#')) continue;
      let path;
      try { path = decodeURIComponent(target.split('#')[0]); }
      catch { errors.push(`${relative(root, file)}: invalid URL ${target}`); continue; }
      if (path && !existsSync(resolve(dirname(file), path))) {
        errors.push(`${relative(root, file)}: missing target ${target}`);
      }
    }
  }
  return { files: files.length, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkDocumentation();
  if (result.errors.length) {
    process.stderr.write(result.errors.join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`ok  documentation links (${result.files} files; relative file links only)\n`);
  }
}
