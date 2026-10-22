#!/usr/bin/env bash
# Install konsole-session-restore for the current user (no root needed).
#
#   ./install.sh [--bin-dir DIR] [--no-opencode]
#
# Safe to re-run: existing settings are merged, not overwritten, and every change
# is recorded in a manifest that uninstall.sh uses to undo exactly that.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
WITH_OPENCODE=auto

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bin-dir) BIN_DIR="$2"; shift 2 ;;
        --no-opencode) WITH_OPENCODE=no; shift ;;
        -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/konsole-state"
UNIT_DIR="${CONFIG}/systemd/user"
AUTOSTART_DIR="${CONFIG}/autostart"
BIN="${BIN_DIR}/konsole-state"
MANIFEST="${STATE}/install-manifest.json"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Preflight -----------------------------------------------------------------
command -v python3 >/dev/null || die "python3 is required"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || die "python3 >= 3.8 is required"
command -v systemctl >/dev/null || die "systemd is required"
systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user session (systemctl --user)"
command -v konsole >/dev/null || die "konsole is not installed"
command -v kreadconfig6 >/dev/null && command -v kwriteconfig6 >/dev/null \
    || die "kreadconfig6/kwriteconfig6 not found (KDE Frameworks 6 is required)"
plasma_major="$(plasmashell --version 2>/dev/null | awk '{print $NF}' | cut -d. -f1)"
[[ "${plasma_major:-0}" -ge 6 ]] || die "KDE Plasma 6 is required (found: ${plasma_major:-none})"
qdbus_found=no
for q in qdbus6 qdbus-qt6 /usr/lib/qt6/bin/qdbus /usr/lib64/qt6/bin/qdbus \
         /usr/lib/x86_64-linux-gnu/qt6/bin/qdbus /usr/lib/aarch64-linux-gnu/qt6/bin/qdbus qdbus; do
    if command -v "$q" >/dev/null 2>&1; then qdbus_found=yes; break; fi
done
[[ "$qdbus_found" == yes ]] || die "qdbus (Qt 6) not found; install your distribution's qt6 tools package"
python3 -c 'import dbus' 2>/dev/null \
    || warn "python3 dbus module missing: window placement (desktops/monitors) will be skipped. Install python3-dbus / python-dbus."
[[ "${XDG_SESSION_TYPE:-}" == wayland ]] || warn "only Plasma Wayland sessions are tested (this is ${XDG_SESSION_TYPE:-unknown})"

if [[ "$WITH_OPENCODE" == auto ]]; then
    if command -v opencode >/dev/null || [[ -d "${CONFIG}/opencode" ]]; then WITH_OPENCODE=yes; else WITH_OPENCODE=no; fi
fi

# --- Files -----------------------------------------------------------------------
mkdir -p "$BIN_DIR" "$UNIT_DIR" "$AUTOSTART_DIR" "$STATE"
install -m 755 "${REPO}/bin/konsole-state" "$BIN"
sed "s|@BIN@|${BIN}|g" "${REPO}/systemd/konsole-state.service" > "${UNIT_DIR}/konsole-state.service"
install -m 644 "${REPO}/systemd/konsole-state.timer" "${UNIT_DIR}/konsole-state.timer"
sed "s|@BIN@|${BIN}|g" "${REPO}/autostart/konsole-state-restore.desktop" \
    > "${AUTOSTART_DIR}/konsole-state-restore.desktop"
say "installed ${BIN}, systemd timer and login autostart entry"

# --- Settings merges (recorded in the manifest) -----------------------------------
WITH_OPENCODE="$WITH_OPENCODE" CONFIG="$CONFIG" REPO="$REPO" BIN="$BIN" MANIFEST="$MANIFEST" \
UNIT_DIR="$UNIT_DIR" AUTOSTART_DIR="$AUTOSTART_DIR" python3 - <<'PY'
import json, os, re, shutil, subprocess
from pathlib import Path

env = os.environ
manifest_path = Path(env["MANIFEST"])
try:
    manifest = json.loads(manifest_path.read_text())
except (OSError, ValueError):
    manifest = {}
manifest.update({
    "bin": env["BIN"],
    "files": [env["BIN"], f"{env['UNIT_DIR']}/konsole-state.service", f"{env['UNIT_DIR']}/konsole-state.timer",
              f"{env['AUTOSTART_DIR']}/konsole-state-restore.desktop"],
})

# Plasma's session restore relaunches Konsole empty at login; exclude it, keeping
# whatever the user already excludes.
KSM = ["kreadconfig6", "--file", "ksmserverrc", "--group", "General", "--key", "excludeApps"]
current = subprocess.run(KSM, capture_output=True, text=True).stdout.strip()
apps = [a for a in re.split(r"[,:]", current) if a]
added = [a for a in ("konsole", "org.kde.konsole", "org.kde.konsole.desktop") if a not in apps]
if added:
    subprocess.run(["kwriteconfig6", "--file", "ksmserverrc", "--group", "General",
                    "--key", "excludeApps", ",".join(apps + added)], check=True)
    print(f"excluded Konsole from Plasma's own session restore ({', '.join(added)})")
manifest["exclude_apps_added"] = sorted(set(manifest.get("exclude_apps_added", [])) | set(added))

# Optional opencode TUI plugins: the session tracker (used by restore) and the
# agent status glyph in the tab title. opencode 2 loads terminal plugins from
# the "plugins" list in cli.json (opencode 1 used tui.json; see tag opencode-v1).
if env["WITH_OPENCODE"] == "yes":
    oc = Path(env["CONFIG"]) / "opencode"
    cli = oc / "cli.json"
    # Older manifests recorded a single plugin; migrate them to the lists.
    plugins_installed = manifest.pop("opencode_plugins", None) or []
    if manifest.get("opencode_plugin"):
        plugins_installed.append(manifest.pop("opencode_plugin"))
    entries = manifest.pop("opencode_config_entries", None) or manifest.pop("tui_json_entries", None) or []
    if manifest.get("tui_json_entry"):
        entries.append(manifest.pop("tui_json_entry"))
    manifest.pop("tui_json_entries", None)
    for name, label in (("konsole-session-tracker.ts", "session tracker"),
                        ("konsole-agent-status.ts", "agent status")):
        plugin = oc / "tui-plugins" / name
        plugin.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(env["REPO"]) / "opencode" / name, plugin)
        if str(plugin) not in plugins_installed:
            plugins_installed.append(str(plugin))
        try:
            cfg = json.loads(cli.read_text()) if cli.exists() else {"$schema": "https://opencode.ai/v2/cli.json"}
        except ValueError:
            print(f"NOTE: {cli} is not plain JSON; add \"{plugin}\" to its \"plugins\" list by hand")
            continue
        plugins = cfg.setdefault("plugins", [])
        if str(plugin) not in plugins:
            plugins.append(str(plugin))
            cli.write_text(json.dumps(cfg, indent=2) + "\n")
        if [str(cli), str(plugin)] not in entries:
            entries.append([str(cli), str(plugin)])
        print(f"installed opencode {label} plugin (restart opencode instances to load it)")
    manifest["opencode_plugins"] = plugins_installed
    manifest["opencode_config_entries"] = entries

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY

# --- Activate ---------------------------------------------------------------------
systemctl --user daemon-reload
systemctl --user enable --now konsole-state.timer >/dev/null 2>&1
say "save timer enabled (every 60 s)"
"$BIN" save --quiet || true

say ""
say "Checking the system:"
"$BIN" doctor || warn "doctor reported problems (see FAIL lines above)"
say ""
say "Done. Windows are saved every minute and restored at the next login."
say "Uninstall with: ${REPO}/uninstall.sh [--purge]"
