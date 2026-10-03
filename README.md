# konsole-session-restore

Save your Konsole windows and tabs, and the place of all your windows, on KDE Plasma 6. Get them back after you log out or reboot.

Every minute, a systemd user timer records a snapshot. When you log in, the tool opens your Konsole windows and tabs again. Then it puts each window back on its virtual desktop and monitor.

## What it restores

| Item | Restored | Note |
|---|---|---|
| Konsole windows, tab order, active tab | Yes | |
| Profile and working directory of each tab | Yes | |
| Visible screen text of each tab | Yes | The tool prints it again in the new tab. |
| Scrollback above the visible screen | No | Konsole does not supply it over D-Bus. |
| Command that ran in a tab | Shown | The tool shows the command. With `restore --run`, it runs the command again. |
| Running processes | No | A process cannot survive a reboot. |
| Split panes | As tabs | Each pane becomes a tab. |
| opencode sessions | Yes | Optional. Each opencode tab opens the session that it showed. |
| Virtual desktop, monitor, size, maximized state | Yes | For Konsole and for other applications, for example Firefox and JetBrains IDEs. |

## Requirements

- KDE Plasma 6, started with systemd (the default).
- A recent Konsole. The tool is tested with Konsole 26.08. `konsole-state doctor` tells you if your Konsole lacks a D-Bus method that the tool uses.
- Python 3.8 or later.
- The Qt 6 `qdbus` tool. Its package name is different on each distribution.
- The Python `dbus` module (`python3-dbus` or `python-dbus`). Without it, the tool does not move windows. Konsole windows and tabs are still restored.
- Optional: opencode, for the opencode session feature.
- Optional: `spectacle`, ImageMagick and `kscreen-doctor`, for `--evidence` only.

The tool is tested on Plasma 6.7 with Wayland. X11 sessions are not tested.

## Install

1. Clone this repository.
2. Run the installer as your normal user, not as root:

   ```sh
   ./install.sh
   ```

3. Read the output of `konsole-state doctor` at the end. Each `FAIL` line tells you what is missing.
4. If you use opencode, restart each opencode instance. The tracker plugin loads only at start.

The installer writes these files:

- `~/.local/bin/konsole-state`
- `~/.config/systemd/user/konsole-state.service` and `konsole-state.timer`
- `~/.config/autostart/konsole-state-restore.desktop`
- `~/.config/opencode/tui-plugins/konsole-session-tracker.ts`, and an entry in `~/.config/opencode/tui.json` (only if opencode is installed)

The installer also adds Konsole to `excludeApps` in `ksmserverrc`. This is the System Settings field "Applications to be excluded from sessions". Without it, Plasma opens an extra empty Konsole window at login. The installer keeps the applications that you already excluded.

Options:

- `--bin-dir DIR` installs the script into `DIR` instead of `~/.local/bin`.
- `--no-opencode` skips the opencode plugin.

You can run the installer again. It does not add duplicate entries.

## Uninstall

```sh
./uninstall.sh            # keeps your saved snapshots
./uninstall.sh --purge    # also deletes them
```

The uninstaller reads the manifest that the installer wrote (`~/.local/state/konsole-state/install-manifest.json`). It removes only the files and settings that the installer added.

## Usage

The timer and the login entry do the work. You do not have to run commands. These commands are available:

| Command | Purpose |
|---|---|
| `konsole-state save` | Record a snapshot now, for example before a reboot. |
| `konsole-state restore [FILE]` | Open the windows of a snapshot. Add `--run` to run saved commands again. |
| `konsole-state place FILE --dry-run` | Show how the windows of a snapshot match your open windows. Remove `--dry-run` to move them. |
| `konsole-state verify EXPECTED ACTUAL` | Compare two snapshots. |
| `konsole-state doctor` | Make sure that this system supports all the features. |

Snapshots are in `~/.local/state/konsole-state/`:

- `session.json` is the newest snapshot.
- `session.last-boot.json` is the last snapshot before the most recent reboot. If the restore at login did not run, restore from this file:

  ```sh
  konsole-state restore ~/.local/state/konsole-state/session.last-boot.json
  ```

## How it works

**Save.** The timer runs `konsole-state save` every 60 seconds. The script reads each Konsole window and tab over D-Bus. It reads the working directory and the command of each tab from `/proc`. It reads the desktop, position and size of every window from KWin over D-Bus. The new snapshot replaces the old one in one atomic step.

A save does not run in three cases. Plasma is shutting down, no Konsole window is open, or another save or restore is running. In these cases the previous snapshot stays. The first save after a reboot keeps the old snapshot as `session.last-boot.json`.

**Restore.** At login, the autostart entry runs `konsole-state restore --if-none`. If a Konsole window is already open, the script does not open Konsole windows. Each saved window opens as a new Konsole process with all its tabs. The script then selects the saved active tab.

**Placement.** After the restore, the script moves windows to their saved desktop and position. It identifies restored Konsole windows by process ID. It identifies other windows by application and title:

1. The exact title.
2. The title without the browser suffix, for example " — Mozilla Firefox".
3. The JetBrains project name.
4. The only window of an application, after 20 seconds.

If no rule gives a match, the window stays where it is. The script looks for new windows for up to 2 minutes, because some applications start slowly. If a saved position is not on a monitor that exists now, the script restores only the desktop. The script moves windows with short KWin scripts.

**Self-check.** About 45 seconds after the restore, the script records a new snapshot and compares it with the restored snapshot. The result goes to the journal (see Troubleshooting).

**opencode.** The plugin records the session that each opencode instance shows. It writes the session ID to `~/.local/state/opencode-tui-sessions/<pid>.json`. The save uses this file, so each tab opens the same session again. This works also after you change the session inside opencode.

## Troubleshooting

To see what the restore did at the last login:

```sh
journalctl --user -b -u 'app-konsole\x2dstate\x2drestore@autostart.service' -o cat
```

Look for these lines:

| Line | Meaning |
|---|---|
| `verify: OK` | All tabs came back correctly. |
| `verify: FAIL ...` | A tab is different from the snapshot. The line gives the difference. |
| `place: ... -> Desktop N @ x,y` | The script moved a window. |
| `place: not found: ...` | A saved window did not open, or its title changed. |
| `place: MISMATCH ...` | A window did not go to the saved position. Usually the monitor layout changed. |
| `place: drift ...` | An application moved its own window after placement. The script moved it back. |
| `Konsole windows already open; not restoring` | A Konsole window was open before the restore. The line names it. |

To see skipped saves before the last reboot:

```sh
journalctl --user -b -1 -u konsole-state.service -o cat
```

A normal save writes nothing to the journal. Only skipped saves and errors appear.

If the panel shows a window from another desktop after login, run `restore` with `--evidence` to record screenshots of the panels. The screenshots go to `~/.local/state/konsole-state/panels/`.

## Known limits

- The tool uses some Konsole and KWin behavior that is not documented. A Plasma or Konsole update can change it. `konsole-state doctor` and the self-check show such changes in the journal.
- A snapshot can be up to 60 seconds old. Before a planned reboot, run `konsole-state save`.
- Konsole reports the active tab only for the window that has focus. For this reason, the self-check reports a wrong active tab as a note, not as a failure.
- The window size at launch uses a title bar of 28 pixels (Breeze at scale 1). Placement corrects a small difference.
- Firefox can mark restored windows as "demands attention". The Plasma task manager shows such windows on all desktops. After placement, the script removes this mark from windows on other desktops.
