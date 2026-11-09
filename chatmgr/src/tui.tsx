import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

import { applyFilters, emptyFilter } from "./core/filter.mjs"
import { keyOf } from "./core/model.mjs"
import { formatLocalDateTime } from "./core/time.mjs"
import { buildArchivePlan, buildDeletePlan, describeArchivePlan, describePlan } from "./core/plan.mjs"
import { PROVIDERS, providerList } from "./core/capabilities.mjs"

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url))
// Rows that fit: terminal height minus title, status, filters, margins, footer.
const CHROME = 10
const termRows = () => Math.max(6, Number(process.stdout.rows) || 30)
const [pageSize, setPageSize] = createSignal(Math.max(5, termRows() - CHROME))
process.stdout.on?.("resize", () => setPageSize(Math.max(5, termRows() - CHROME)))

type Row = {
  provider: string
  id: string
  title: string
  projectPath: string
  lastActivity: number
  archived: boolean
  running: boolean
  childCount?: number
  automated?: boolean
}

const [rows, setRows] = createSignal<Row[]>([])
const [cursor, setCursor] = createSignal(0)
const [selected, setSelected] = createSignal<Set<string>>(new Set())
const [filter, setFilter] = createSignal(emptyFilter())
const [status, setStatus] = createSignal("loading…")
const [errors, setErrors] = createSignal<string[]>([])
const [busy, setBusy] = createSignal(false)
const [keepBackup, setKeepBackup] = createSignal(true)
// True while any dialog is on screen. The panel's own keys (Enter = resume,
// Esc = close...) must not fire then, or they swallow the dialog's Enter/Esc.
const [dialogOpen, setDialogOpen] = createSignal(false)

function callCli(args: string[]): Promise<any> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [CLI, ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        try {
          resolve(JSON.parse(String(stdout)))
        } catch {
          resolve({ ok: false, error: String(error?.message ?? stdout).slice(0, 400) })
        }
      },
    )
  })
}

function visibleRows(): Row[] {
  return applyFilters(rows(), filter())
}

async function refresh() {
  setStatus("loading…")
  // The panel filters locally, so it fetches everything (incl. archived and automated).
  const result = await callCli(["list", "--json", "--archived", "--automated"])
  if (result?.conversations) {
    setRows(result.conversations)
    setErrors((result.errors ?? []).map((row: any) => `${row.provider}: ${row.error}`))
    setStatus("")
    const live = new Set(result.conversations.map(keyOf))
    setSelected((current) => new Set([...current].filter((key) => live.has(key))))
  } else {
    setStatus(`load failed: ${result?.error ?? "unknown error"}`)
  }
  setCursor((value) => Math.max(0, Math.min(value, visibleRows().length - 1)))
}

function toggleCurrent() {
  const row = visibleRows()[cursor()]
  if (!row) return
  const next = new Set(selected())
  const key = keyOf(row)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  setSelected(next)
}

function selectAllFiltered() {
  setSelected(new Set([...selected(), ...visibleRows().map(keyOf)]))
}

function currentKey(): string | null {
  const row = visibleRows()[cursor()]
  return row ? keyOf(row) : null
}

export default Plugin.define({
  id: "chatmgr",
  async setup(context) {
    const theme = context.theme
    const base = () => theme?.text?.base ?? "white"
    const muted = () => theme?.text?.muted ?? "gray"
    const accent = () => theme?.text?.accent ?? "cyan"
    const warning = () => theme?.text?.warning ?? "yellow"

    let dialogDepth = 0
    const dialog: any = {}
    for (const name of ["alert", "confirm", "select", "prompt"]) {
      dialog[name] = async (...args: any[]) => {
        dialogDepth += 1
        setDialogOpen(true)
        try {
          return await (context.ui.dialog as any)[name](...args)
        } finally {
          dialogDepth -= 1
          if (dialogDepth <= 0) setDialogOpen(false)
        }
      }
    }

    context.ui.router.register({ name: "chatmgr", render: () => <Manager /> })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "chatmgr.open",
          title: "Conversations: OpenCode, Codex, Claude, Hermes",
          group: "Chatmgr",
          bind: "ctrl+shift+l",
          palette: true,
          slash: { name: "conversations", aliases: ["chats", "chatmgr"] },
          run: async () => {
            await refresh()
            context.ui.router.navigate({ type: "plugin", name: "chatmgr" })
          },
        },
        {
          id: "chatmgr.backups",
          title: "Chatmgr: show deletion backups",
          group: "Chatmgr",
          palette: true,
          run: async () => {
            const result = await callCli(["backups"])
            const lines = (result.backups ?? []).map(
              (row: any) => `${row.createdAt} · ${row.items} item(s) · ${row.manifest}`,
            )
            await dialog.alert({
              title: "Deletion backups",
              message:
                (lines.length ? lines.join("\n") : "No backups yet.") +
                "\n\nRestore: node agent-hub/chatmgr/src/cli.mjs restore --manifest <file>",
            })
          },
        },
      ],
      bindings: ["chatmgr.open"],
    }))

    function Manager() {
      const cursorRow = createMemo(() => visibleRows()[cursor()])
      const start = createMemo(() => {
        const n = visibleRows().length
        if (n <= pageSize()) return 0
        return Math.max(0, Math.min(cursor() - Math.floor(pageSize() / 2), n - pageSize()))
      })

      context.keymap.layer(() => dialogOpen() ? ({ mode: "global", priority: 20, commands: [], bindings: [] }) : ({
        mode: "global",
        priority: 20,
        commands: [
          { id: "chatmgr.down", bind: "down", run: () => setCursor((v) => Math.min(v + 1, Math.max(0, visibleRows().length - 1))) },
          { id: "chatmgr.up", bind: "up", run: () => setCursor((v) => Math.max(0, v - 1)) },
          { id: "chatmgr.pageDown", bind: "pagedown", run: () => setCursor((v) => Math.min(v + pageSize(), Math.max(0, visibleRows().length - 1))) },
          { id: "chatmgr.pageUp", bind: "pageup", run: () => setCursor((v) => Math.max(0, v - pageSize())) },
          { id: "chatmgr.toggle", bind: "space", run: toggleCurrent },
          { id: "chatmgr.all", bind: "a", run: selectAllFiltered },
          { id: "chatmgr.clear", bind: "c", run: () => setSelected(new Set()) },
          { id: "chatmgr.refresh", bind: "r", run: () => void refresh() },
          { id: "chatmgr.search", bind: "/", run: () => void editSearch() },
          { id: "chatmgr.project", bind: "o", run: () => void editProject() },
          { id: "chatmgr.before", bind: "b", run: () => void editBefore() },
          { id: "chatmgr.agent", bind: "f", run: () => void editAgent() },
          {
            id: "chatmgr.archived",
            bind: "x",
            run: () => setFilter({ ...filter(), includeArchived: !filter().includeArchived }),
          },
          { id: "chatmgr.preview", bind: "p", run: () => void showPreview() },
          { id: "chatmgr.archive", bind: "m", run: () => void archiveSelected() },
          {
            id: "chatmgr.automated",
            bind: "t",
            run: () => setFilter({ ...filter(), includeAutomated: !filter().includeAutomated }),
          },
          { id: "chatmgr.backup", bind: "k", run: () => { setKeepBackup(!keepBackup()); setStatus(keepBackup() ? "deletes keep a backup" : "deletes are permanent (no backup)") } },
          { id: "chatmgr.resume", bind: "return", run: () => void resume() },
          { id: "chatmgr.delete", bind: "ctrl+d", run: () => void deleteSelected() },
          { id: "chatmgr.close", bind: "escape", run: () => context.ui.router.navigate({ type: "home" }) },
        ],
        bindings: [
          "chatmgr.down",
          "chatmgr.up",
          "chatmgr.pageDown",
          "chatmgr.pageUp",
          "chatmgr.toggle",
          "chatmgr.all",
          "chatmgr.clear",
          "chatmgr.refresh",
          "chatmgr.search",
          "chatmgr.project",
          "chatmgr.before",
          "chatmgr.agent",
          "chatmgr.archived",
          "chatmgr.preview",
          "chatmgr.archive",
          "chatmgr.backup",
          "chatmgr.automated",
          "chatmgr.resume",
          "chatmgr.delete",
          "chatmgr.close",
        ],
      }))

      async function editAgent() {
        const options = [
          { title: "All agents", value: "all" },
          ...providerList().map((p) => ({
            title: p.label,
            value: p.id,
            description: p.delete ? "delete supported" : "read-only",
          })),
        ]
        const picked = await dialog.select({ title: "Filter by agent", options })
        if (!picked) return
        setFilter({ ...filter(), agents: picked === "all" ? null : [picked] })
      }

      async function editProject() {
        const value = await dialog.prompt({ title: "Exact project path (empty = any)", placeholder: "D:\\repo" })
        if (value === undefined) return
        setFilter({ ...filter(), project: value.trim() || null })
      }

      async function editBefore() {
        const value = await dialog.prompt({ title: "Last activity before (YYYY-MM-DD)", placeholder: "2026-11-01" })
        if (value === undefined) return
        setFilter({ ...filter(), before: value.trim() || null })
      }

      async function editSearch() {
        const value = await dialog.prompt({ title: "Search title or path", placeholder: "parser" })
        if (value === undefined) return
        setFilter({ ...filter(), query: value })
      }

      async function showPreview() {
        const row = cursorRow()
        if (!row) return
        setStatus(`preview: ${row.title}`)
        const result = await callCli(["preview", "--key", keyOf(row)])
        setStatus("")
        if (result.ok) await dialog.alert({ title: row.title, message: result.text || "(empty transcript)" })
        else await dialog.alert({ title: "Preview failed", message: result.error })
      }

      async function resume() {
        const row = cursorRow()
        if (!row) return
        if (row.provider === "opencode") {
          context.ui.router.navigate({ type: "session", sessionID: row.id })
          return
        }
        const hint = (PROVIDERS[row.provider]?.resumeHint ?? `resume ${row.id}`).replace("<id>", row.id)
        await dialog.alert({
          title: `Resume ${PROVIDERS[row.provider]?.label ?? row.provider}`,
          message: `Run in a terminal:\n\n  ${hint}\n\nEach agent reopens its own transcript; nothing is converted.`,
        })
      }

      async function archiveSelected() {
        if (busy()) return
        const chosen = selected().size
          ? rows().filter((row) => selected().has(keyOf(row)))
          : [cursorRow()].filter(Boolean)
        if (chosen.length === 0) {
          await dialog.alert({ title: "Nothing selected", message: "Space toggles a row; a selects all filtered rows." })
          return
        }
        const plan = buildArchivePlan(chosen as Row[])
        const keys = plan.items.map(keyOf)
        if (keys.length === 0) {
          await dialog.alert({ title: "Nothing to archive", message: describeArchivePlan(plan) })
          return
        }
        const confirmed = await dialog.confirm({
          title: `${describeArchivePlan(plan)}?`,
          message:
            `Only agents with a single-session archive command take part (Codex).\n` +
            `Rows already archived are unarchived by the same action.\n` +
            `Running and unsupported rows are skipped.`,
          label: { confirm: "Apply", cancel: "Cancel" },
        })
        if (!confirmed) return

        setBusy(true)
        const result = await callCli(["archive", "--keys", keys.join(","), "--yes"])
        setBusy(false)
        const lines = (result.results ?? []).map((row: any) => {
          const mark = row.status === "ok" ? "OK " : row.status === "blocked" ? "SKIP " : "FAIL "
          return `${mark}${row.provider} ${row.id}${row.action ? ` (${row.action})` : ""}${row.error ? ` — ${row.error}` : ""}`
        })
        await dialog.alert({ title: result.ok ? "Archive updated" : "Partially updated", message: lines.join("\n") })
        await refresh()
      }

      async function deleteSelected() {
        if (busy()) return
        let chosen = rows().filter((row) => selected().has(keyOf(row)))
        // Nothing marked with space: act on the row under the cursor.
        if (chosen.length === 0 && cursorRow()) chosen = [cursorRow() as Row]
        if (chosen.length === 0) {
          await dialog.alert({ title: "Nothing to delete", message: "The list is empty." })
          return
        }
        const plan = buildDeletePlan(chosen, { currentKey: currentKey() })
        const keys = plan.items.map(keyOf)
        if (keys.length === 0) {
          await dialog.alert({ title: "Nothing deletable", message: describePlan(plan) })
          return
        }

        const confirmed = await dialog.confirm({
          title: `Delete ${keys.length} conversation${keys.length === 1 ? "" : "s"}?`,
          message:
            `${describePlan(plan)}\n\n` +
            (keepBackup()
              ? `A recoverable backup is written first under agent-hub/chatmgr/backups.\n`
              : `NO backup: this deletion cannot be undone.\n`) +
            `Running and unsupported rows are skipped, never forced.` +
            (plan.sideEffects.length ? `\n\nEffects:\n- ${plan.sideEffects.join("\n- ")}` : ""),
          label: { confirm: "Delete", cancel: "Cancel" },
        })
        if (!confirmed) return

        setBusy(true)
        setStatus(`deleting ${keys.length}…`)
        const result = await callCli(["delete", "--keys", keys.join(","), "--yes", ...(keepBackup() ? [] : ["--no-backup"])])
        setBusy(false)

        const lines = (result.results ?? []).map((row: any) => {
          const mark = row.status === "ok" ? "OK " : row.status === "blocked" ? "SKIP " : "FAIL "
          return `${mark}${row.provider} ${row.id}${row.error ? ` — ${row.error}` : ""}`
        })
        if (result.backup) lines.push("", `Backup: ${result.backup.manifest}`)
        await dialog.alert({ title: result.ok ? "Deleted" : "Partially deleted", message: lines.join("\n") })
        setSelected(new Set())
        await refresh()
      }

      const filterLine = () => {
        const f = filter()
        const parts = [
          `agents ${f.agents?.join(",") ?? "all"}`,
          `path ${f.project ?? "any"}`,
          `before ${f.before ?? "any"}`,
          `archived ${f.includeArchived ? "shown" : "hidden"}`,
          `automated ${f.includeAutomated ? "shown" : "hidden"}`,
        ]
        if (f.query) parts.push(`search ${f.query}`)
        return parts.join(" · ")
      }

      return (
        <box flexDirection="column" padding={1}>
          <text fg={base()}>Conversations</text>
          <text fg={muted()}>{visibleRows().length} of {rows().length} conversations{rows().length > visibleRows().length ? ` (${rows().length - visibleRows().length} hidden by filters)` : ""} · {selected().size} selected{status() ? ` · ${status()}` : ""}</text>
          <text fg={muted()}>{filterLine()}</text>
          <Show when={errors().length > 0}>
            <text fg={warning()}>{errors().join(" · ")}</text>
          </Show>
          <box flexDirection="column" marginTop={1}>
            <For each={visibleRows().slice(start(), start() + pageSize())}>
              {(row, index) => {
                const absolute = () => start() + index()
                const active = () => absolute() === cursor()
                const checked = () => selected().has(keyOf(row))
                const agent = (PROVIDERS[row.provider]?.label ?? row.provider).padEnd(11)
                const flags = `${row.archived ? "arch" : "    "} ${row.running ? "run" : "   "}`
                return (
                  <text fg={active() ? accent() : checked() ? base() : muted()}>
                    {active() ? ">" : " "} {checked() ? "[x]" : "[ ]"} {agent} {formatLocalDateTime(row.lastActivity)} {flags} {row.title} · {row.projectPath}
                  </text>
                )
              }}
            </For>
            <Show when={visibleRows().length === 0}>
              <text fg={muted()}>No conversations match. r refreshes, x shows archived, c clears selection.</text>
            </Show>
          </box>
          <text fg={muted()}>up/down move · space select · a all filtered · c clear · p preview · enter resume · m archive · k backup on/off · t automated · ctrl+d delete (cursor row if none selected) · f/o/b/x filters · r refresh · esc close</text>
        </box>
      )
    }

    void refresh()
  },
})
