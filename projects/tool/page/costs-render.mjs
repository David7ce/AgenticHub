// costs-render.mjs — a self-contained, offline chart page for token usage.
import { readFileSync } from 'node:fs';

import { buildCostsView } from '../lib/costs.mjs';
import { applyShell } from './shared.mjs';

const PAGE_DIR = new URL('./', import.meta.url);
const readClient = (name) => readFileSync(new URL(name, PAGE_DIR), 'utf8');
const inline = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export function renderCostsPage(ledger, now = new Date()) {
  const data = `const LEDGER = ${inline(ledger)};\nconst VIEW = ${inline(buildCostsView(ledger, now))};\n`
    + readClient('usage-range.js') + '\n'
    + readClient('costs.js').replace('const LEDGER = /*COSTS_DATA*/;\nconst VIEW = /*COSTS_VIEW*/;\n', '');
  try {
    new Function(data);
  } catch (error) {
    throw new Error(`costs page script does not parse: ${error.message}`);
  }
  return applyShell(readClient('costs.html'), 'ia')
    .replace('/*COSTS_STYLES*/', () => readClient('costs.css'))
    .replace('/*COSTS_SCRIPT*/', () => data);
}
