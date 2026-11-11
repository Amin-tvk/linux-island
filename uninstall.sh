#!/usr/bin/env bash
# Removes both versions of Linux Island.
set -uo pipefail

UUID="linux-island@miverasan.com"

if command -v gnome-extensions >/dev/null; then
    gnome-extensions disable "$UUID" 2>/dev/null
fi
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

"$HOME/.local/bin/linux-island" --quit >/dev/null 2>&1
rm -f "$HOME/.local/bin/linux-island" \
      "${XDG_DATA_HOME:-$HOME/.local/share}/applications/linux-island.desktop" \
      "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/linux-island.desktop"
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/linux-island"

echo "Linux Island removed. Your settings in ~/.config/linux-island were kept."
