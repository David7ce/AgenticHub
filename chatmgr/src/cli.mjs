#!/usr/bin/env node
/**
 * JSON-first engine behind the TUI panel. Every command prints one JSON object,
 * so the panel never parses human text and the same commands are usable from a
 * terminal.
 *
 *   node cli.mjs list [--agent a,b] [--project P] [--before YYYY-MM-DD]
 *                     [--archived] [--query Q] [--current-key K]
 *   node cli.mjs preview --key provider:id
 *   node cli.mjs delete --keys k1,k2 [--yes] [--dry-run] [--backup-dir D]
 *   node cli.mjs delete ... [--no-backup] [--no-prune] [--prune-days N]
 *   node cli.mjs prune-backups [--days N] [--yes]
 *   node cli.mjs backups | restore --manifest F | backup-remove --dir D
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adapters } from "./providers/index.mjs";
import { runProcess } from "./providers/exec.mjs";
import { applyFilters, emptyFilter, normalizeFilter } from "./core/filter.mjs";
import { keyOf, sortConversations } from "./core/model.mjs";
import { createSelection, selectedConversations } from "./core/selection.mjs";
import { buildArchivePlan, buildDeletePlan, describeArchivePlan, describePlan } from "./core/plan.mjs";
import { createBackup, removeBackup, restoreBackup } from "./core/backup.mjs";
import { executeArchive, executeDeletes } from "./core/execute.mjs";
import { listBackups, pruneBackups } from "./core/backup-store.mjs";
import { PROVIDERS } from "./core/capabilities.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const defaultBackupRoot = join(here, "..", "backups");

function parseArgs(argv) {
  const [command = "list", ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function filterFrom(flags) {
  return normalizeFilter({
    ...emptyFilter(),
    agents: typeof flags.agent === "string" ? flags.agent.split(",") : null,
    project: typeof flags.project === "string" ? flags.project : null,
    before: typeof flags.before === "string" ? flags.before : null,
    includeArchived: flags.archived === true,
    includeAutomated: flags.automated === true,
    query: typeof flags.query === "string" ? flags.query : "",
  });
}

async function collect(flags) {
  const providers = { ...adapters, run: runProcess };
  const entries = Object.keys(adapters);
  const settled = await Promise.allSettled(entries.map((id) => adapters[id].list()));
  const byKey = new Map();
  const errors = [];
  settled.forEach((result, index) => {
    const id = entries[index];
    if (result.status !== "fulfilled") {
      errors.push({ provider: id, error: String(result.reason?.message ?? result.reason) });
      return;
    }
    for (const conv of result.value) {
      // One source of truth per provider:id: a host that re-exposes the same
      // conversation (VS Code, an IDE integration) must not create a duplicate.
      if (!byKey.has(keyOf(conv))) byKey.set(keyOf(conv), conv);
    }
  });
  return { providers, conversations: sortConversations([...byKey.values()]), errors };
}

async function cmdList(flags) {
  const { conversations, errors } = await collect(flags);
  const filter = filterFrom(flags);
  const filtered = applyFilters(conversations, filter);
  return {
    ok: errors.length === 0 || filtered.length > 0,
    filter,
    total: conversations.length,
    shown: filtered.length,
    providers: errors.length ? errors.map((row) => row.provider) : Object.keys(adapters),
    errors,
    conversations: filtered,
  };
}

async function cmdPreview(flags) {
  if (!flags.key) throw new Error("--key provider:id is required");
  const [provider, ...rest] = String(flags.key).split(":");
  const id = rest.join(":");
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`unknown provider ${provider}`);
  const { conversations } = await collect({ automated: true });
  const conv = conversations.find((row) => row.provider === provider && row.id === id);
  if (!conv) throw new Error(`conversation not found: ${flags.key}`);
  const text = await adapter.preview(conv, {});
  return { ok: true, key: flags.key, title: conv.title, text };
}

async function cmdDelete(flags) {
  const keys = typeof flags.keys === "string" ? flags.keys.split(",").filter(Boolean) : [];
  if (keys.length === 0) throw new Error("--keys is required");
  const { providers, conversations } = await collect({ automated: true });
  const selection = createSelection(keys);
  const selected = selectedConversations(selection, conversations);
  const missing = keys.filter((key) => !selected.some((conv) => keyOf(conv) === key));
  const plan = buildDeletePlan(selected, { currentKey: flags["current-key"] ?? null });

  if (!flags.yes || flags["dry-run"] === true) {
    return {
      ok: true,
      dryRun: true,
      plan: {
        summary: describePlan(plan),
        scope: plan.scope,
        sideEffects: plan.sideEffects,
        descendants: plan.descendants,
        delete: plan.items.map((conv) => ({ key: keyOf(conv), provider: conv.provider, id: conv.id, title: conv.title })),
        blocked: plan.blocked.map((row) => ({ key: keyOf(row.conv), code: row.code, message: row.message })),
        missing,
      },
    };
  }

  const backupRoot = typeof flags["backup-dir"] === "string" ? flags["backup-dir"] : defaultBackupRoot;
  const backup = flags["no-backup"] === true
    ? null
    : {
        create: (items) => createBackup(items, { root: backupRoot, providers }),
      };

  const result = await executeDeletes(plan, { providers, backup });
  // Old safety copies age out on their own after a backed-up delete.
  const pruned = backup && flags["no-prune"] !== true
    ? pruneBackups(backupRoot, { days: Number(flags["prune-days"]) || 14 })
    : [];
  return {
    pruned,
    ok: result.failed === 0,
    summary: describePlan(plan),
    backup: result.backup ? { dir: result.backup.dir, manifest: result.backup.manifestPath } : null,
    okCount: result.ok,
    failedCount: result.failed,
    blockedCount: result.blocked,
    results: result.results,
  };
}

async function cmdPruneBackups(flags) {
  const root = typeof flags["backup-dir"] === "string" ? flags["backup-dir"] : defaultBackupRoot;
  const days = Number(flags.days) || 14;
  const removed = pruneBackups(root, { days, dryRun: flags.yes !== true });
  return { ok: true, dryRun: flags.yes !== true, days, removed };
}

async function cmdArchive(flags) {
  const keys = typeof flags.keys === "string" ? flags.keys.split(",").filter(Boolean) : [];
  if (keys.length === 0) throw new Error("--keys is required");
  const { providers, conversations } = await collect({ automated: true });
  const selected = selectedConversations(createSelection(keys), conversations);
  const missing = keys.filter((key) => !selected.some((conv) => keyOf(conv) === key));
  const plan = buildArchivePlan(selected);

  if (!flags.yes || flags["dry-run"] === true) {
    return {
      ok: true,
      dryRun: true,
      plan: {
        summary: describeArchivePlan(plan),
        archive: plan.items.filter((conv) => !conv.archived).map((conv) => ({ key: keyOf(conv), title: conv.title })),
        unarchive: plan.items.filter((conv) => conv.archived).map((conv) => ({ key: keyOf(conv), title: conv.title })),
        blocked: plan.blocked.map((row) => ({ key: keyOf(row.conv), code: row.code, message: row.message })),
        missing,
      },
    };
  }

  const result = await executeArchive(plan, { providers });
  return {
    ok: result.failed === 0,
    summary: describeArchivePlan(plan),
    okCount: result.ok,
    failedCount: result.failed,
    blockedCount: result.blocked,
    results: result.results,
  };
}

function cmdBackups(flags) {
  return { ok: true, backups: listBackups(typeof flags["backup-dir"] === "string" ? flags["backup-dir"] : defaultBackupRoot) };
}

function cmdRestore(flags) {
  if (!flags.manifest) throw new Error("--manifest is required");
  return { ok: true, ...restoreBackup(String(flags.manifest)) };
}

function cmdBackupRemove(flags) {
  if (!flags.dir) throw new Error("--dir is required");
  removeBackup(String(flags.dir));
  return { ok: true, removed: String(flags.dir) };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const handlers = {
    list: cmdList,
    preview: cmdPreview,
    delete: cmdDelete,
    archive: cmdArchive,
    backups: cmdBackups,
    restore: cmdRestore,
    "backup-remove": cmdBackupRemove,
    "prune-backups": cmdPruneBackups,
    providers: async () => ({ ok: true, providers: Object.values(PROVIDERS) }),
  };
  const handler = handlers[command];
  if (!handler) throw new Error(`unknown command ${command}`);
  const result = await handler(flags);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  });
}
