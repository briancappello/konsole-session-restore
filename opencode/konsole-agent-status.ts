/**
 * Shows the agent state of this opencode TUI as a glyph in its Konsole tab title.
 *
 *   🔴 blocked  a permission or question waits for the user (also from subagents)
 *   🟡 working  the session is busy (or retrying)
 *   🟢 done     the session finished; stays until the next prompt
 *
 * Konsole's default tab title format (e.g. "%d : %n") ignores titles set by
 * programs through OSC escapes, so the glyph is prepended to the tab title
 * *format* over D-Bus instead. The original formats are restored on exit.
 * Does nothing when not running inside Konsole.
 */
import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

type State = "none" | "working" | "blocked" | "done"

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

function currentSessionID(api: TuiPluginApi): string | null {
  const route = api.route.current
  if (route.name !== "session") return null
  const id = (route.params as { sessionID?: unknown } | undefined)?.sessionID
  return typeof id === "string" ? id : null
}

const tui = async (api: TuiPluginApi) => {
  if (!service || !object) return
  const qdbus = findQdbus()
  if (!qdbus) return

  const readFormat = (ctx: number): string | null => {
    try {
      const out = execFileSync(qdbus, [service, object, "tabTitleFormat", String(ctx)], {
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
  for (const ctx of CONTEXTS) {
    const fmt = readFormat(ctx)
    if (fmt !== null) original.set(ctx, fmt)
  }
  if (original.size === 0) return

  // Pending permission/question requests across all sessions, by request ID.
  const pending = new Map<string, string>() // requestID -> sessionID
  // Parent of each session seen so far (null = root); used to attribute subagent requests.
  const parent = new Map<string, string | null>()
  const lookups = new Set<string>()
  // Sessions this TUI has seen run, so idle after work reads as "done".
  const ran = new Set<string>()

  let shown: State = "none"
  let disposed = false

  const learnParent = (sessionID: string) => {
    if (parent.has(sessionID) || lookups.has(sessionID)) return
    lookups.add(sessionID)
    api.client.session
      .get({ sessionID })
      .then((res) => {
        const info = (res as { data?: { parentID?: string } }).data
        if (info) {
          parent.set(sessionID, info.parentID ?? null)
          if (info.parentID) learnParent(info.parentID)
        }
      })
      .catch(() => {})
      .finally(() => {
        lookups.delete(sessionID)
        update()
      })
  }

  const belongsTo = (sessionID: string, root: string): boolean => {
    for (let id: string | null | undefined = sessionID, hops = 0; id && hops < 32; hops++) {
      if (id === root) return true
      id = parent.get(id)
    }
    return false
  }

  const compute = (): State => {
    const root = currentSessionID(api)
    if (!root) return "none"
    if (api.state.session.permission(root).length > 0 || api.state.session.question(root).length > 0) {
      return "blocked"
    }
    for (const sessionID of pending.values()) if (belongsTo(sessionID, root)) return "blocked"
    const status = api.state.session.status(root)?.type
    if (status === "busy" || status === "retry") {
      ran.add(root)
      return "working"
    }
    return ran.has(root) ? "done" : "none"
  }

  const apply = (state: State) => {
    for (const [ctx, fmt] of original) {
      execFile(qdbus, [service, object, "setTabTitleFormat", String(ctx), GLYPH[state] + fmt], { timeout: 2000 }, () => {})
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

  const ask = (e: { properties: { id: string; sessionID: string } }) => {
    pending.set(e.properties.id, e.properties.sessionID)
    learnParent(e.properties.sessionID)
    update()
  }
  const answer = (e: { properties: { requestID: string } }) => {
    pending.delete(e.properties.requestID)
    update()
  }
  const track = (e: { properties: { info: { id: string; parentID?: string } } }) => {
    parent.set(e.properties.info.id, e.properties.info.parentID ?? null)
  }

  const unsubscribe = [
    api.event.on("permission.asked", ask),
    api.event.on("permission.replied", answer),
    api.event.on("question.asked", ask),
    api.event.on("question.replied", answer),
    api.event.on("question.rejected", answer),
    api.event.on("session.created", track),
    api.event.on("session.updated", track),
    api.event.on("session.status", update),
    api.event.on("session.idle", update),
    api.event.on("session.error", update),
  ]

  update()
  // Route changes have no event; polling also covers any missed bus event.
  const timer = setInterval(update, POLL_MS)

  api.lifecycle.onDispose(() => {
    disposed = true
    clearInterval(timer)
    for (const off of unsubscribe) off()
    // Synchronous: the process may exit right after dispose.
    for (const [ctx, fmt] of original) {
      try {
        execFileSync(qdbus, [service, object, "setTabTitleFormat", String(ctx), fmt], { timeout: 2000 })
      } catch {}
    }
  })
}

export default { id: "konsole-agent-status", tui }
