#!/usr/bin/env bash
# Linux Island installer.
#
#   ./install.sh               pick the right version for this desktop
#   ./install.sh gnome         force the GNOME Shell extension
#   ./install.sh standalone    force the standalone app (KDE, Hyprland, Sway, XFCE…)
#   ./install.sh standalone --no-deps   don't touch system packages

set -euo pipefail

UUID="linux-island@miverasan.com"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-auto}"
NO_DEPS=0
for a in "$@"; do [[ "$a" == "--no-deps" ]] && NO_DEPS=1; done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "$MODE" == "auto" || "$MODE" == "--no-deps" ]]; then
    if [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* ]] && command -v gnome-shell >/dev/null; then
        MODE=gnome
    else
        MODE=standalone
    fi
fi

install_gnome() {
    bold "Installing the GNOME Shell extension"
    command -v gnome-shell >/dev/null || die "gnome-shell not found"
    local ver major
    ver="$(gnome-shell --version | grep -oE '[0-9]+(\.[0-9]+)*' | head -1)"
    major="${ver%%.*}"
    info "GNOME Shell $ver"
    (( major >= 46 )) || die "GNOME $major is too old (needs 46 or newer). Try: ./install.sh standalone"

    local dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r "$HERE"/gnome-extension/. "$dest"/
    rm -f "$dest/schemas/gschemas.compiled"
    glib-compile-schemas "$dest/schemas"
    if ! grep -q "\"$major\"" "$dest/metadata.json"; then
        info "GNOME $major is not in the tested list; enabling it anyway"
        sed -i "s/\"shell-version\": \[/\"shell-version\": [\"$major\", /" "$dest/metadata.json"
    fi
    info "copied to $dest"

    # The shell only knows about new extensions after a re-login, so add it
    # to the enabled list directly instead of asking the running shell.
    local enabled
    enabled="$(gsettings get org.gnome.shell enabled-extensions)"
    enabled="$(python3 -c '
import ast, sys
cur = sys.argv[1].removeprefix("@as ").strip()
uuids = ast.literal_eval(cur) if cur else []
if sys.argv[2] not in uuids:
    uuids.append(sys.argv[2])
print(str(uuids))' "$enabled" "$UUID")"
    gsettings set org.gnome.shell enabled-extensions "$enabled"
    gsettings set org.gnome.shell disable-user-extensions false

    echo
    bold "Done."
    if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
        info "Log out and log back in once – GNOME on Wayland only loads new extensions at login."
    else
        info "Press Alt+F2, type r and Enter to restart GNOME Shell (or log out and in)."
    fi
    info "Settings:  gnome-extensions prefs $UUID"
    info "Shortcut:  Super+Alt+H expands / collapses the island"
}

install_deps() {
    (( NO_DEPS )) && return
    local pkgs
    if command -v apt-get >/dev/null; then
        pkgs="python3-gi python3-gi-cairo python3-cairo gir1.2-gtk-3.0 gir1.2-gtklayershell-0.1"
        bold "Installing packages with apt: $pkgs"
        sudo apt-get install -y $pkgs
    elif command -v dnf >/dev/null; then
        pkgs="python3-gobject python3-cairo gtk3 gtk-layer-shell"
        bold "Installing packages with dnf: $pkgs"
        sudo dnf install -y $pkgs
    elif command -v pacman >/dev/null; then
        pkgs="python-gobject python-cairo gtk3 gtk-layer-shell"
        bold "Installing packages with pacman: $pkgs"
        sudo pacman -S --needed --noconfirm $pkgs
    elif command -v zypper >/dev/null; then
        pkgs="python3-gobject python3-gobject-cairo python3-cairo typelib-1_0-Gtk-3_0 typelib-1_0-GtkLayerShell-0_1"
        bold "Installing packages with zypper: $pkgs"
        sudo zypper install -y $pkgs
    elif command -v xbps-install >/dev/null; then
        pkgs="python3-gobject python3-cairo gtk+3 gtk-layer-shell"
        bold "Installing packages with xbps: $pkgs"
        sudo xbps-install -y $pkgs
    elif command -v apk >/dev/null; then
        pkgs="py3-gobject3 py3-cairo gtk+3.0 gtk-layer-shell"
        bold "Installing packages with apk: $pkgs"
        sudo apk add $pkgs
    else
        info "Unknown package manager. Install by hand: PyGObject, pycairo, GTK 3 and gtk-layer-shell."
    fi
}

install_standalone() {
    bold "Installing the standalone app"
    if [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* && "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
        info "Note: GNOME on Wayland can't place this window at the top. Use ./install.sh gnome there."
    fi
    install_deps

    python3 - <<'PY' || die "Python GTK bindings are missing (see the package list above)."
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk  # noqa: F401
import cairo  # noqa: F401
PY
    if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]] && ! python3 -c \
        "import gi; gi.require_version('GtkLayerShell', '0.1')" 2>/dev/null; then
        info "warning: gtk-layer-shell not found – on Wayland the island will be a normal window."
    fi

    local bin="$HOME/.local/bin"
    local apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    local autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
    mkdir -p "$bin" "$apps" "$autostart"
    install -m 755 "$HERE/standalone/linux_island.py" "$bin/linux-island"
    sed "s|^Exec=.*|Exec=$bin/linux-island|" "$HERE/standalone/linux-island.desktop" > "$apps/linux-island.desktop"
    cp "$apps/linux-island.desktop" "$autostart/linux-island.desktop"
    info "installed $bin/linux-island (starts automatically at login)"

    "$bin/linux-island" --quit >/dev/null 2>&1 || true
    nohup "$bin/linux-island" >/dev/null 2>&1 &
    disown || true

    echo
    bold "Done – the island is running."
    info "Config:    ${XDG_CONFIG_HOME:-$HOME/.config}/linux-island/config.json (restart after editing)"
    info "Shortcut:  bind  $bin/linux-island --toggle  to a key in your desktop's keyboard settings"
    info "           Hyprland: bind = SUPER ALT, H, exec, linux-island --toggle"
    info "           Sway:     bindsym Mod4+Mod1+h exec linux-island --toggle"
}

case "$MODE" in
    gnome) install_gnome ;;
    standalone) install_standalone ;;
    *) die "unknown mode '$MODE' (use gnome or standalone)" ;;
esac
