#!/usr/bin/env bash
# Behavioral check for the opencode 2 TUI plugins. Needs bun. Run: opencode/check.sh
# Fakes qdbus and the TUI context, and asserts the tab-title glyph and session file.
set -euo pipefail
repo=${1:-$(cd "$(dirname "$0")/.." && pwd)}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir "$work/bin" "$work/state"
cat > "$work/bin/qdbus6" <<'EOF'
#!/bin/sh
echo "$*" >> "$QDBUS_LOG"
[ "$3" = tabTitleFormat ] && echo "%d : %n"
exit 0
EOF
chmod +x "$work/bin/qdbus6"

cat > "$work/run.mjs" <<'EOF'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { readFileSync, existsSync } = await import("node:fs")
const log = () => (existsSync(process.env.QDBUS_LOG) ? readFileSync(process.env.QDBUS_LOG, "utf8") : "")
const lastTitle = () => log().trim().split("\n").filter((l) => l.includes("setTabTitleFormat 0")).at(-1)?.split(" 0 ")[1]
const fail = (msg) => { console.error("FAIL:", msg, "\n" + log()); process.exit(1) }

let route = { type: "home" }
let status = "idle"
const handlers = new Map()
const sessions = { root: {}, child: { parentID: "root" } }
const ctx = {
  ui: { router: { current: () => route } },
  data: {
    on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type) },
    session: {
      get: (id) => sessions[id],
      family: () => ["child"],
      status: () => status,
      permission: { list: () => undefined },
      form: { list: (id) => (id === "child" ? [{ id: "f-old" }] : undefined) },
    },
  },
}
const emit = (type, data) => handlers.get(type)?.({ type, data })

const status_ = (await import(process.env.PLUGINS + "/konsole-agent-status.ts")).default
const tracker = (await import(process.env.PLUGINS + "/konsole-session-tracker.ts")).default
if (status_.id !== "konsole-agent-status" || typeof status_.setup !== "function") fail("bad agent-status definition")
const stopStatus = status_.setup(ctx)
const stopTracker = tracker.setup(ctx)
await sleep(50)
if (lastTitle() !== "%d : %n") fail("first write should clear any stale glyph")

route = { type: "session", sessionID: "root" }
await sleep(600)
if (lastTitle() !== "🔴 %d : %n") fail("pre-existing subagent form should seed blocked")
emit("form.replied", { id: "f-old", sessionID: "child" })
await sleep(50)
if (lastTitle() !== "%d : %n") fail("answered form should clear blocked")

status = "running"; emit("session.execution.started", { sessionID: "root" })
await sleep(50)
if (lastTitle() !== "🟡 %d : %n") fail("running should show working")

emit("permission.asked", { id: "p1", sessionID: "child" })
await sleep(50)
if (lastTitle() !== "🔴 %d : %n") fail("subagent permission should show blocked")
emit("permission.replied", { requestID: "p1", sessionID: "child" })
await sleep(50)
if (lastTitle() !== "🟡 %d : %n") fail("reply should return to working")

emit("form.created", { form: { id: "f2", sessionID: "other" } })
await sleep(50)
if (lastTitle() !== "🟡 %d : %n") fail("form from an unrelated session must not block")

status = "idle"; emit("session.execution.succeeded", { sessionID: "root" })
await sleep(50)
if (lastTitle() !== "🟢 %d : %n") fail("finished session should show done")

const file = `${process.env.XDG_STATE_HOME}/opencode-tui-sessions/${process.pid}.json`
await sleep(1100)
if (JSON.parse(readFileSync(file, "utf8")).sessionID !== "root") fail("tracker should record the routed session")

stopStatus(); stopTracker()
if (lastTitle() !== "%d : %n") fail("cleanup should restore the original format")
if (existsSync(file)) fail("tracker cleanup should remove its state file")
console.log("ok")
process.exit(0)
EOF

PLUGINS=$repo/opencode QDBUS_LOG=$work/qdbus.log XDG_STATE_HOME=$work/state PATH="$work/bin:$PATH" \
  KONSOLE_DBUS_SERVICE=org.kde.konsole-test KONSOLE_DBUS_SESSION=/Sessions/1 \
  bun "$work/run.mjs"
