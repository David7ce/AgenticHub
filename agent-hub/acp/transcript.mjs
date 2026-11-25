// transcript.mjs — per-session transcripts: one JSONL file per ACP session.
//
// Records are redacted at write time, so a key the agent echoes never reaches
// disk. A turn's text is written as a whole when the turn ends, so a key split
// across streamed chunks cannot slip through. Legacy transcripts, written one
// text record per chunk, are redacted once after merging on read. Strings are
// truncated BEFORE redaction: redact() is slow on very long inputs and throws
// on non-strings. The turn text emitted at stop is the one exception: it is
// redacted whole and linearly, and only then sliced to the per-record cap.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.mjs';

const MAX_TITLE_CHARS = 300;
export const MAX_TEXT_CHARS = 4000;

const clean = (value, max) => redact(String(value ?? '').slice(0, max));

export function transcriptPath(dir, acpSessionId) {
  return join(dir, `${String(acpSessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
}

/** Map a session/update to a transcript record, or null for kinds not kept. */
export function toRecord(update, now) {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
      return { t: now, kind: 'text', text: clean(update.content?.text, MAX_TEXT_CHARS) };
    case 'tool_call':
    case 'tool_call_update':
      return {
        t: now,
        kind: 'tool',
        id: clean(update.toolCallId, MAX_TITLE_CHARS),
        title: clean(update.title, MAX_TITLE_CHARS),
        toolKind: clean(update.kind, MAX_TITLE_CHARS),
        status: clean(update.status, MAX_TITLE_CHARS),
      };
    case 'usage_update':
      return { t: now, kind: 'usage', cost: update.cost?.amount ?? null };
    default:
      return null;
  }
}

/** Build a prompt/permission/stop record with the same truncate-then-redact rules. */
export function eventRecord(kind, fields, now) {
  const out = { t: now, kind };
  for (const [key, value] of Object.entries(fields)) {
    out[key] = clean(value, key === 'text' ? MAX_TEXT_CHARS : MAX_TITLE_CHARS);
  }
  return out;
}

export function appendTranscript(dir, acpSessionId, record) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(transcriptPath(dir, acpSessionId), JSON.stringify(record) + '\n', 'utf8');
  } catch {}
}

/** Newest first. `before` is a record index (after merging) for paging. */
export function readTranscript(dir, acpSessionId, { before, limit = 50, textOnly = false } = {}) {
  const file = transcriptPath(dir, acpSessionId);
  if (!existsSync(file)) return { records: [], total: 0 };
  const merged = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (textOnly && rec.kind !== 'text' && rec.kind !== 'prompt') continue;
    const last = merged[merged.length - 1];
    if (rec.kind === 'text' && last?.kind === 'text') last.text += rec.text;
    else merged.push(rec);
  }
  // A turn's text now arrives already redacted as one record. Older transcripts
  // hold one record per streamed chunk, and a key split across two of those
  // matched nothing at write time but reassembles here. One pass over the
  // merged records makes both safe and is linear, unlike redacting after every
  // merge.
  for (const record of merged) {
    if (record.kind === 'text') record.text = redact(record.text);
  }
  const total = merged.length;
  const end = Math.min(before ?? total, total);
  const start = Math.max(0, end - limit);
  const records = [];
  for (let i = end - 1; i >= start; i--) records.push({ index: i, ...merged[i] });
  return { records, total };
}
