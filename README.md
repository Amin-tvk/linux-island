# Linux Island

**A Dynamic Island for Linux.** A black pill at the top of the screen that shows what's playing, pops out your notifications and runs a timer – then shrinks back out of the way.

![GNOME version: idle, clock & timer, now playing, expanded player, notification, timer, time's up](docs/screenshots.png)

## Features

- **Now playing from any app** – browsers (YouTube, SoundCloud…), Spotify, VLC, Rhythmbox, mpv, podcasts… anything that speaks MPRIS. Cover art, title, artist, progress bar with click-to-seek, play / pause / next / previous.
- **Colours follow the cover art** – the equalizer, progress bar and soft glow take the cover's accent colour.
- **Notifications in the island** – Telegram, WhatsApp, Discord, mail… show up as a banner inside the pill. On GNOME it replaces GNOME's own banner (they still land in the message list); click to open the app.
- **Timer** – presets (1 / 5 / 10 / 25 min by default), pause, stop, a sound and an orange glow when time is up.
- **Clock** – click the idle pill for the time, date and timer.
- **Stays out of your way** – only the pill itself takes clicks, it hides in full-screen apps, and it can hide completely when idle.
- **Gestures** – hover to expand, scroll sideways to skip tracks, click the player name to switch between players.
- **Right-to-left text** (Persian, Arabic, Hebrew) renders correctly.
- Nothing leaves your computer. Notification text is never saved.

## Two versions

| | Desktop | How it works |
|---|---|---|
| **GNOME extension** (`gnome-extension/`) | GNOME 46–50 on Ubuntu, Fedora, Debian, Arch, openSUSE, Pop!_OS… (tested on GNOME 50) | Runs inside GNOME Shell, sits under the top bar |
| **Standalone app** (`standalone/`) | KDE Plasma, Hyprland, Sway, Wayfire, river, XFCE, Cinnamon, MATE, Budgie… | Python + GTK 3. Wayland: layer-shell surface. X11: always-on-top dock window |

![Standalone version: expanded player and notification](docs/standalone.png)

## Install

```bash
git clone https://github.com/Amin-tvk/linux-island.git
cd linux-island
./install.sh
```

The installer picks the right version for your desktop. To choose yourself:

```bash
./install.sh gnome        # GNOME Shell extension
./install.sh standalone   # everything else
```

### GNOME

After installing, **log out and back in once** (GNOME on Wayland only loads new extensions at login). Then:

- **Super + Alt + H** – expand / collapse the island
- Settings: `gnome-extensions prefs linux-island@miverasan.com`, or the gear in the clock view, or the Extensions app

### Other desktops

The installer adds the required packages with your package manager (apt, dnf, pacman, zypper, xbps or apk), installs `~/.local/bin/linux-island`, starts it and adds it to autostart. Use `--no-deps` to skip the package step.

| Distro | Packages |
|---|---|
| Debian / Ubuntu / Mint / Pop | `python3-gi python3-gi-cairo python3-cairo gir1.2-gtk-3.0 gir1.2-gtklayershell-0.1` |
| Fedora | `python3-gobject python3-cairo gtk3 gtk-layer-shell` |
| Arch / Manjaro / EndeavourOS | `python-gobject python-cairo gtk3 gtk-layer-shell` |
| openSUSE | `python3-gobject python3-gobject-cairo python3-cairo typelib-1_0-Gtk-3_0 typelib-1_0-GtkLayerShell-0_1` |

Bind `linux-island --toggle` to a key in your keyboard settings:

```
# Hyprland
bind = SUPER ALT, H, exec, linux-island --toggle
# Sway / i3
bindsym Mod4+Mod1+h exec linux-island --toggle
```

Settings live in `~/.config/linux-island/config.json` (restart the app after editing):

```json
{
  "show_media": true,
  "show_notifications": true,
  "hide_when_idle": false,
  "expand_on_hover": true,
  "top_margin": 6,
  "notification_duration": 5,
  "timer_presets": [1, 5, 10, 25],
  "ignore_apps": [],
  "monitor": null
}
```

The standalone app reads notifications with a read-only D-Bus monitor, so your notification daemon (Plasma, dunst, mako, swaync, xfce4-notifyd…) keeps showing its own popups too. If you want them only in the island, turn popups off in that daemon (for example Plasma: *System Settings → Notifications → Do not disturb* or hide popups; mako: `default-timeout`/`invisible=1`). Clicking a notification in the standalone app dismisses it; it can't open the sending app.

## Uninstall

```bash
./uninstall.sh
```

## Troubleshooting

- **GNOME: nothing appears** – make sure you logged out and in, then check `gnome-extensions info linux-island@miverasan.com` and `journalctl --user -b | grep -i island`.
- **A player isn't shown** – check it supports MPRIS: `busctl --user list | grep mpris`. Firefox needs `media.hardwaremediakeys.enabled` (on by default).
- **Standalone on Wayland is a normal window** – `gtk-layer-shell` isn't installed, or your compositor doesn't support layer-shell (GNOME). Run `linux-island` from a terminal to see messages.

## Development

GNOME: the extension is plain GJS (ES modules). Test it without touching your session in a nested shell:

```bash
dbus-run-session -- gnome-shell --devkit   # GNOME 49+, needs mutter-dev-bin
```

Standalone: `python3 standalone/linux_island.py`.

Inspired by [HALO](https://github.com/ecch1369/halo) for Windows. Linux Island is an independent implementation; no code is shared.

## License

MIT – see [LICENSE](LICENSE).

---

<div dir="rtl">

## فارسی

**Linux Island** یک «دایناميک آیلند» برای لینوکس است: یک قرص مشکی بالای صفحه که آهنگ در حال پخش (از هر برنامه‌ای مثل مرورگر، اسپاتیفای، VLC)، نوتیفیکیشن‌ها و تایمر را نشان می‌دهد.

- روی **گنوم** (اوبونتو، فدورا، دبیان، آرچ…) به‌صورت اکستنشن نصب می‌شود.
- روی **KDE، Hyprland، Sway، XFCE، Cinnamon** و بقیه به‌صورت برنامه‌ی مستقل اجرا می‌شود.

نصب: دستورهای بخش Install را اجرا کنید؛ اسکریپت خودش نسخه‌ی مناسب را انتخاب می‌کند. در گنوم بعد از نصب یک بار log out و دوباره login کنید. میانبر: <code>Super+Alt+H</code>

</div>
