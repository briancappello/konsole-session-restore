/**
 * Records which session this opencode TUI instance is showing, keyed by PID.
 *
 * Writes $XDG_STATE_HOME/opencode-tui-sessions/<pid>.json (default
 * ~/.local/state/...) whenever the route changes, and removes it on exit.
 * Consumed by ~/.local/bin/konsole-state to reopen the same session after a
 * reboot, regardless of how the instance was started or which session the
 * user switched to inside the TUI.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const POLL_MS = 1000

const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "opencode-tui-sessions")
const stateFile = join(stateDir, `${process.pid}.json`)

function currentSessionID(api: TuiPluginApi): string | null {
  const route = api.route.current
  if (route.name !== "session") return null
  const id = (route.params as { sessionID?: unknown } | undefined)?.sessionID
  return typeof id === "string" ? id : null
}

function write(sessionID: string | null) {
  mkdirSync(stateDir, { recursive: true })
  const tmp = `${stateFile}.tmp`
  writeFileSync(
    tmp,
    JSON.stringify({ pid: process.pid, sessionID, cwd: process.cwd(), updatedAt: Date.now() }) + "\n",
  )
  renameSync(tmp, stateFile)
}

const tui = async (api: TuiPluginApi) => {
  let last: string | null | undefined
  const tick = () => {
    try {
      const id = currentSessionID(api)
      if (id === last) return
      write(id)
      last = id
    } catch {
      // Never let bookkeeping break the TUI.
    }
  }
  tick()
  const timer = setInterval(tick, POLL_MS)
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    rmSync(stateFile, { force: true })
  })
}

export default { id: "konsole-session-tracker", tui }
