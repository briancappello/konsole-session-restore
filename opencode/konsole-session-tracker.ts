/**
 * Records which session this opencode TUI instance is showing, keyed by PID.
 *
 * Writes $XDG_STATE_HOME/opencode-tui-sessions/<pid>.json (default
 * ~/.local/state/...) whenever the route changes, and removes it on exit.
 * Consumed by ~/.local/bin/konsole-state to reopen the same session after a
 * reboot, regardless of how the instance was started or which session the
 * user switched to inside the TUI.
 *
 * Requires OpenCode 2. The OpenCode 1 version is tagged `opencode-v1`.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"

const POLL_MS = 1000

const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "opencode-tui-sessions")
const stateFile = join(stateDir, `${process.pid}.json`)

function currentSessionID(ctx: Plugin.Context): string | null {
  const route = ctx.ui.router.current()
  return route.type === "session" ? route.sessionID : null
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

function setup(ctx: Plugin.Context) {
  let last: string | null | undefined
  const tick = () => {
    try {
      const id = currentSessionID(ctx)
      if (id === last) return
      write(id)
      last = id
    } catch {
      // Never let bookkeeping break the TUI.
    }
  }
  tick()
  const timer = setInterval(tick, POLL_MS)
  return () => {
    clearInterval(timer)
    rmSync(stateFile, { force: true })
  }
}

// Plain object rather than Plugin.define (an identity function), so the file
// has no runtime dependency on the plugin package.
export default { id: "konsole-session-tracker", setup } satisfies Plugin.Definition
