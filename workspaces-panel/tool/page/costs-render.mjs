// costs-render.mjs — usage data for the common offline document renderer.

import { buildCostsView, subscriptionHistory } from '../lib/costs.mjs';
import { readPageAsset, renderDocument } from './shared.mjs';

export function renderCostsPage(ledger, now = new Date()) {
  return renderDocument(readPageAsset('costs.html'), 'ia', {
    page: ['costs.css', 'usage-range.js', 'costs.js'],
    data: {
      LEDGER: { generatedAt: ledger.generatedAt, rows: subscriptionHistory(ledger) },
      VIEW: buildCostsView(ledger, now),
    },
  });
}
