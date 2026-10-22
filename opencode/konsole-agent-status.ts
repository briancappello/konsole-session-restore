/**
 * Shows the agent state of this opencode TUI as a glyph in its Konsole tab title.
 *
 *   🔴 blocked  a permission or question waits for the user (also from subagents)
 *   🟡 working  the session is busy
 *   🟢 done     the session finished; stays until the next prompt
 *
 * Konsole's default tab title format (e.g. "%d : %n") ignores titles set by
 * programs through OSC escapes, so the glyph is prepended to the tab title
 * *format* over D-Bus instead. The original formats are restored on exit.
 * Does nothing when not running inside Konsole.
 *
 * Requires OpenCode 2. The OpenCode 1 version is tagged `opencode-v1`.
 */
import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"

type State = "none" | "working" | "blocked" | "done"
type Context = Plugin.Context

const GLYPH: Record<State, string> = { none: "", working: "🟡 ", blocked: "🔴 ", done: "🟢 " }
const OWN_PREFIX = /^(?:🟡|🔴|🟢) /u
const CONTEXTS = [0, 1] // 0 = local tab title format, 1 = remote (ssh) tab title format
const POLL_MS = 500

const service = process.env.KONSOLE_DBUS_SERVICE
const object = process.env.KONSOLE_DBUS_SESSION

function findQdbus(): string | null {
  const candidates = [
    "qdbus6",
    "qdbus-qt6",
    "/usr/lib/qt6/bin/qdbus",
    "/usr/lib64/qt6/bin/qdbus",
    "/usr/lib/x86_64-linux-gnu/qt6/bin/qdbus",
    "/usr/lib/aarch64-linux-gnu/qt6/bin/qdbus",
    "qdbus",
  ]
  const path = (process.env.PATH || "").split(delimiter).filter(Boolean)
  for (const c of candidates) {
    if (c.startsWith("/")) {
      if (existsSync(c)) return c
    } else {
      for (const dir of path) if (existsSync(join(dir, c))) return join(dir, c)
    }
  }
  return null
}

function setup(ctx: Context) {
  if (!service || !object) return
  const qdbus = findQdbus()
  if (!qdbus) return

  const readFormat = (tab: number): string | null => {
    try {
      const out = execFileSync(qdbus, [service, object, "tabTitleFormat", String(tab)], {
        encoding: "utf8",
        timeout: 2000,
      })
      // Strip a glyph left behind by an instance that did not exit cleanly.
      return out.replace(/\n$/, "").replace(OWN_PREFIX, "")
    } catch {
      return null
    }
  }

  const original = new Map<number, string>()
  for (const tab of CONTEXTS) {
    const fmt = readFormat(tab)
    if (fmt !== null) original.set(tab, fmt)
  }
  if (original.size === 0) return

  // Pending permission/form requests reported by events, by "kind:requestID".
  // Events can arrive before the data cache reflects them, so they stay the
  // source of truth; the cache only seeds requests that predate this TUI.
  const pending = new Map<string, string>() // key -> sessionID
  // Parents learned from events, for sessions the data cache has not loaded.
  const parents = new Map<string, string | undefined>()
  // Sessions this TUI has seen run, so idle after work reads as "done".
  const ran = new Set<string>()

  // Undefined forces the first write, which also clears a stale glyph left by a crash.
  let shown: State | undefined
  let seeded: string | undefined
  let disposed = false

  const root = (sessionID: string): string => {
    let id = sessionID
    for (let hops = 0; hops < 32; hops++) {
      const parent = ctx.data.session.get(id)?.parentID ?? parents.get(id)
      if (!parent) return id
      id = parent
    }
    return id
  }

  const currentRoot = (): string | undefined => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? root(route.sessionID) : undefined
  }

  const seed = (rootID: string) => {
    for (const member of new Set([rootID, ...ctx.data.session.family(rootID)])) {
      for (const item of ctx.data.session.permission.list(member) ?? []) pending.set(`permission:${item.id}`, member)
      for (const item of ctx.data.session.form.list(member) ?? []) pending.set(`form:${item.id}`, member)
    }
  }

  const compute = (): State => {
    const rootID = currentRoot()
    if (!rootID) return "none"
    if (seeded !== rootID) {
      seeded = rootID
      seed(rootID)
    }
    for (const sessionID of pending.values()) if (root(sessionID) === rootID) return "blocked"
    if (ctx.data.session.status(rootID) === "running") {
      ran.add(rootID)
      return "working"
    }
    return ran.has(rootID) ? "done" : "none"
  }

  const apply = (state: State) => {
    for (const [tab, fmt] of original) {
      execFile(qdbus, [service, object, "setTabTitleFormat", String(tab), GLYPH[state] + fmt], { timeout: 2000 }, () => {})
    }
  }

  const update = () => {
    if (disposed) return
    try {
      const next = compute()
      if (next === shown) return
      shown = next
      apply(next)
    } catch {
      // Never let the indicator break the TUI.
    }
  }

  const unsubscribe = [
    ctx.data.on("session.created", (e) => {
      parents.set(e.data.sessionID, e.data.parentID)
    }),
    ctx.data.on("session.deleted", (e) => {
      parents.delete(e.data.sessionID)
      for (const [key, owner] of pending) if (owner === e.data.sessionID) pending.delete(key)
      update()
    }),
    ctx.data.on("permission.asked", (e) => {
      pending.set(`permission:${e.data.id}`, e.data.sessionID)
      update()
    }),
    ctx.data.on("permission.replied", (e) => {
      pending.delete(`permission:${e.data.requestID}`)
      update()
    }),
    ctx.data.on("form.created", (e) => {
      pending.set(`form:${e.data.form.id}`, e.data.form.sessionID)
      update()
    }),
    ctx.data.on("form.replied", (e) => {
      pending.delete(`form:${e.data.id}`)
      update()
    }),
    ctx.data.on("form.cancelled", (e) => {
      pending.delete(`form:${e.data.id}`)
      update()
    }),
    ctx.data.on("session.execution.started", (e) => {
      ran.add(root(e.data.sessionID))
      update()
    }),
    ctx.data.on("session.execution.succeeded", update),
    ctx.data.on("session.execution.failed", update),
    ctx.data.on("session.execution.interrupted", update),
  ]

  update()
  // Route changes have no event; polling also covers any missed event.
  const timer = setInterval(update, POLL_MS)

  return () => {
    disposed = true
    clearInterval(timer)
    for (const off of unsubscribe) off()
    // Synchronous: the process may exit right after cleanup.
    for (const [tab, fmt] of original) {
      try {
        execFileSync(qdbus, [service, object, "setTabTitleFormat", String(tab), fmt], { timeout: 2000 })
      } catch {}
    }
  }
}

// Plain object rather than Plugin.define (an identity function), so the file
// has no runtime dependency on the plugin package.
export default { id: "konsole-agent-status", setup } satisfies Plugin.Definition
