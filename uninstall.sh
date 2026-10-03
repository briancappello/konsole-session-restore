#!/usr/bin/env bash
# Remove konsole-session-restore, undoing exactly what install.sh recorded.
#
#   ./uninstall.sh [--purge]
#
# --purge also deletes saved snapshots (~/.local/state/konsole-state) and the
# opencode tracker state; without it they are kept.
set -euo pipefail

PURGE=no
[[ "${1:-}" == "--purge" ]] && PURGE=yes
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}"
STATE="${STATE_ROOT}/konsole-state"
MANIFEST="${STATE}/install-manifest.json"
[[ -f "$MANIFEST" ]] || { echo "error: no install manifest at ${MANIFEST}; nothing to undo" >&2; exit 1; }

systemctl --user disable --now konsole-state.timer >/dev/null 2>&1 || true

MANIFEST="$MANIFEST" python3 - <<'PY'
import json, os, re, subprocess
from pathlib import Path

m = json.loads(Path(os.environ["MANIFEST"]).read_text())
for f in m.get("files", []):
    Path(f).unlink(missing_ok=True)
    print(f"removed {f}")

added = set(m.get("exclude_apps_added", []))
if added:
    KSM = ["--file", "ksmserverrc", "--group", "General", "--key", "excludeApps"]
    current = subprocess.run(["kreadconfig6", *KSM], capture_output=True, text=True).stdout.strip()
    keep = [a for a in re.split(r"[,:]", current) if a and a not in added]
    subprocess.run(["kwriteconfig6", *KSM, ",".join(keep)], check=True)
    print("restored Plasma session-restore exclusions")

if m.get("tui_json_entry"):
    tui, plugin = m["tui_json_entry"]
    try:
        cfg = json.loads(Path(tui).read_text())
        if plugin in cfg.get("plugin", []):
            cfg["plugin"].remove(plugin)
            Path(tui).write_text(json.dumps(cfg, indent=2) + "\n")
            print(f"removed plugin entry from {tui}")
    except (OSError, ValueError):
        print(f"NOTE: remove \"{plugin}\" from {tui} by hand")
if m.get("opencode_plugin"):
    Path(m["opencode_plugin"]).unlink(missing_ok=True)
    print(f"removed {m['opencode_plugin']}")
PY

systemctl --user daemon-reload
rm -f "$MANIFEST"
if [[ "$PURGE" == yes ]]; then
    rm -rf "$STATE" "${STATE_ROOT}/opencode-tui-sessions"
    echo "deleted saved snapshots"
else
    echo "kept saved snapshots in ${STATE} (use --purge to delete)"
fi
echo "Uninstalled. Running opencode instances keep the tracker until restarted."
