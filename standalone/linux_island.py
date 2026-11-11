#!/usr/bin/env python3
"""Linux Island (standalone): a Dynamic-Island style pill for KDE Plasma,
Hyprland, Sway, Wayfire, XFCE, Cinnamon, MATE… any desktop except GNOME,
which has its own extension in ../gnome-extension.

Wayland: drawn as a layer-shell surface (needs gtk-layer-shell).
X11: drawn as an always-on-top dock window.

    linux-island            start (or do nothing if already running)
    linux-island --toggle   expand / collapse (bind this to a shortcut)
    linux-island --quit     stop it
"""

import hashlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkPixbuf', '2.0')
gi.require_version('Pango', '1.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, Pango, PangoCairo  # noqa: E402

try:
    gi.require_version('GtkLayerShell', '0.1')
    from gi.repository import GtkLayerShell
except (ValueError, ImportError):
    GtkLayerShell = None

import cairo  # noqa: E402

APP_ID = 'io.github.amintvk.LinuxIsland'
CONFIG_DIR = os.path.join(GLib.get_user_config_dir(), 'linux-island')
CONFIG_PATH = os.path.join(CONFIG_DIR, 'config.json')
CACHE_DIR = os.path.join(GLib.get_user_cache_dir(), 'linux-island')

DEFAULT_CONFIG = {
    'show_media': True,
    'show_notifications': True,
    'hide_when_idle': False,
    'expand_on_hover': True,
    'top_margin': 6,
    'notification_duration': 5,
    'timer_presets': [1, 5, 10, 25],
    'ignore_apps': [],
    'monitor': None,
    'scale': 1.0,
    'animation_speed': 1.0,
}

# Island size [w, h] for every state.
SIZES = {
    'idle': (120, 10),
    'idle-open': (360, 120),
    'timer': (170, 34),
    'media': (300, 36),
    'media-open': (420, 172),
    'notification': (420, 78),
    'done': (280, 52),
}

WIN_W, WIN_H = 480, 220   # transparent window the island lives in
TOP = 10                  # room above the island for the glow
DEFAULT_ACCENT = (0.92, 0.92, 0.96)
TIMER_COLOR = (1.0, 0.70, 0.36)

MPRIS_PREFIX = 'org.mpris.MediaPlayer2.'
MPRIS_PATH = '/org/mpris/MediaPlayer2'
PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player'
IGNORED_PLAYERS = {'org.mpris.MediaPlayer2.playerctld'}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, 'w') as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
    except (OSError, ValueError) as e:
        print(f'linux-island: ignoring bad config: {e}', file=sys.stderr)
    return cfg


def now_us():
    return GLib.get_monotonic_time()


def fmt_us(us):
    s = max(0, int(us // 1_000_000))
    return f'{s // 60}:{s % 60:02d}'


def fmt_ms(ms):
    s = math.ceil(ms / 1000)
    h, m = s // 3600, (s % 3600) // 60
    return f'{h}:{m:02d}:{s % 60:02d}' if h else f'{m:02d}:{s % 60:02d}'


def strip_markup(text):
    text = re.sub(r'<[^>]*>', '', text or '')
    for a, b in (('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&apos;', "'"), ('&amp;', '&')):
        text = text.replace(a, b)
    return re.sub(r'\s+', ' ', text).strip()


def as_text(v):
    if isinstance(v, (list, tuple)):
        return ', '.join(x for x in v if isinstance(x, str))
    return v if isinstance(v, str) else ''


# --------------------------------------------------------------------------
# MPRIS


class Player:
    def __init__(self, bus_name, on_change):
        self.bus_name = bus_name
        self._on_change = on_change
        self.status = 'Stopped'
        self.title = self.artist = self.album = self.art_url = self.track_id = ''
        self.length = 0
        self.can_next = self.can_prev = self.can_seek = False
        self.identity = ''
        self.desktop_entry = ''
        self.last_active = 0
        self._pos = 0
        self._pos_time = 0
        self._proxy = None
        self._cancel = Gio.Cancellable()
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None,
                                  bus_name, MPRIS_PATH, PLAYER_IFACE, self._cancel, self._on_proxy)
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None,
                                  bus_name, MPRIS_PATH, 'org.mpris.MediaPlayer2', self._cancel, self._on_root)

    def _on_root(self, _src, res):
        try:
            root = Gio.DBusProxy.new_for_bus_finish(res)
        except GLib.Error:
            return
        self._root = root
        ident = root.get_cached_property('Identity')
        entry = root.get_cached_property('DesktopEntry')
        self.identity = ident.unpack() if ident else ''
        self.desktop_entry = entry.unpack() if entry else ''
        self._on_change(self)

    def _on_proxy(self, _src, res):
        try:
            self._proxy = Gio.DBusProxy.new_for_bus_finish(res)
        except GLib.Error:
            return
        self._proxy.connect('g-properties-changed', lambda *a: self._sync())
        self._proxy.connect('g-signal', self._on_signal)
        self._sync()
        self.refresh_position()

    def _on_signal(self, _proxy, _sender, signal, params):
        if signal == 'Seeked':
            self._set_position(params.unpack()[0])

    def _prop(self, name, default=None):
        v = self._proxy.get_cached_property(name)
        return v.unpack() if v is not None else default

    def _sync(self):
        old_track = self.track_id + self.title
        status = self._prop('PlaybackStatus', 'Stopped')
        was_playing = self.status == 'Playing'
        if status != self.status:
            self._pos = self.position
            self._pos_time = now_us()
        self.status = status
        meta = self._prop('Metadata', {}) or {}
        self.title = as_text(meta.get('xesam:title'))
        self.artist = as_text(meta.get('xesam:artist'))
        self.album = as_text(meta.get('xesam:album'))
        self.art_url = as_text(meta.get('mpris:artUrl'))
        self.track_id = as_text(meta.get('mpris:trackid'))
        try:
            self.length = int(meta.get('mpris:length', 0) or 0)
        except (TypeError, ValueError):
            self.length = 0
        self.can_next = bool(self._prop('CanGoNext', False))
        self.can_prev = bool(self._prop('CanGoPrevious', False))
        self.can_seek = bool(self._prop('CanSeek', False)) and self.length > 0
        changed = old_track != self.track_id + self.title
        if self.status == 'Playing' and (not was_playing or changed):
            self.last_active = now_us()
        if changed:
            self.refresh_position()
        self._on_change(self)

    def _set_position(self, pos):
        self._pos = int(pos)
        self._pos_time = now_us()

    @property
    def position(self):
        pos = self._pos
        if self.status == 'Playing' and self._pos_time:
            pos += now_us() - self._pos_time
        return min(pos, self.length) if self.length > 0 else pos

    def refresh_position(self):
        def done(conn, res):
            try:
                self._set_position(conn.call_finish(res).unpack()[0])
            except GLib.Error:
                pass
        Gio.bus_get_sync(Gio.BusType.SESSION, None).call(
            self.bus_name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            GLib.Variant('(ss)', (PLAYER_IFACE, 'Position')), None,
            Gio.DBusCallFlags.NONE, 1000, self._cancel, done)

    @property
    def valid(self):
        return self._proxy is not None and self.title != '' and self.status != 'Stopped'

    def _call(self, method, params=None):
        if self._proxy:
            self._proxy.call(method, params, Gio.DBusCallFlags.NONE, 2000, None, None)

    def play_pause(self):
        self._call('PlayPause')

    def next(self):
        self._call('Next')

    def previous(self):
        self._call('Previous')

    def seek_to(self, fraction):
        if not self.can_seek:
            return
        target = int(max(0.0, min(1.0, fraction)) * self.length)
        if self.track_id.startswith('/') and not self.track_id.endswith('/NoTrack'):
            self._call('SetPosition', GLib.Variant('(ox)', (self.track_id, target)))
        else:
            self._call('Seek', GLib.Variant('(x)', (target - self.position,)))
        self._set_position(target)

    def raise_(self):
        root = getattr(self, '_root', None)
        if root:
            root.call('Raise', None, Gio.DBusCallFlags.NONE, 2000, None, None)

    def destroy(self):
        self._cancel.cancel()


class Mpris:
    def __init__(self, on_change):
        self._on_change = on_change
        self._players = {}
        self._pinned = None
        self._pinned_at = 0
        self.active = None
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                             '/org/freedesktop/DBus', None, Gio.DBusSignalFlags.NONE, self._on_owner)
        names = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                              'ListNames', None, None, Gio.DBusCallFlags.NONE, -1, None).unpack()[0]
        for n in names:
            if n.startswith(MPRIS_PREFIX):
                self._add(n)

    def _on_owner(self, _c, _s, _p, _i, _sig, params):
        name, old, new = params.unpack()
        if not name.startswith(MPRIS_PREFIX):
            return
        if old:
            self._remove(name)
        if new:
            self._add(name)

    def _add(self, name):
        if name in self._players or name in IGNORED_PLAYERS:
            return
        self._players[name] = Player(name, lambda _p: self._update())

    def _remove(self, name):
        p = self._players.pop(name, None)
        if p:
            if self._pinned is p:
                self._pinned = None
            p.destroy()
            self._update()

    @property
    def players(self):
        return [p for p in self._players.values() if p.valid]

    def _update(self):
        players = self.players
        if self._pinned in players:
            active = self._pinned
        else:
            active = max(players, key=lambda p: p.last_active, default=None)
        started = [p for p in players if p.status == 'Playing' and p.last_active > self._pinned_at]
        if (active is None or active.status != 'Playing') and started:
            active = max(started, key=lambda p: p.last_active)
            self._pinned = None
        self.active = active
        self._on_change()

    def cycle(self):
        players = self.players
        if len(players) < 2:
            return
        i = players.index(self.active) if self.active in players else -1
        self._pinned = players[(i + 1) % len(players)]
        self._pinned_at = now_us()
        self._update()


# --------------------------------------------------------------------------
# Notifications: watch Notify calls on the session bus (read-only monitor).


class NotificationMonitor:
    def __init__(self, on_notification):
        self._on_notification = on_notification
        self._conn = None
        try:
            addr = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, None)
            self._conn = Gio.DBusConnection.new_for_address_sync(
                addr,
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
                Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None)
            self._conn.add_filter(self._filter)
            self._conn.call_sync(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.Monitoring',
                'BecomeMonitor',
                GLib.Variant('(asu)', ([
                    "type='method_call',interface='org.freedesktop.Notifications',member='Notify'"], 0)),
                None, Gio.DBusCallFlags.NONE, -1, None)
        except GLib.Error as e:
            print(f'linux-island: cannot watch notifications: {e.message}', file=sys.stderr)

    # Runs on the GDBus worker thread.
    def _filter(self, _conn, msg, incoming):
        if incoming and msg.get_message_type() == Gio.DBusMessageType.METHOD_CALL \
                and msg.get_member() == 'Notify':
            try:
                body = msg.get_body().unpack()
                GLib.idle_add(self._on_notification, body)
            except Exception as e:  # noqa: BLE001 - never kill the bus thread
                print(f'linux-island: bad notification: {e}', file=sys.stderr)
            return None  # not for us: don't let GDBus try to answer it
        return msg


def notification_pixbuf(app_icon, hints, size):
    data = hints.get('image-data') or hints.get('image_data') or hints.get('icon_data')
    try:
        if data:
            w, h, stride, alpha, bits, _ch, pixels = data
            pb = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(bytes(pixels)), GdkPixbuf.Colorspace.RGB,
                                                 alpha, bits, w, h, stride)
            return pb.scale_simple(size, size, GdkPixbuf.InterpType.BILINEAR)
        path = hints.get('image-path') or hints.get('image_path') or app_icon
        if path:
            if path.startswith('file://'):
                path = Gio.File.new_for_uri(path).get_path()
            if path.startswith('/'):
                return GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, True)
            return Gtk.IconTheme.get_default().load_icon(path, size, Gtk.IconLookupFlags.FORCE_SIZE)
    except (GLib.Error, ValueError, TypeError):
        pass
    return None


# --------------------------------------------------------------------------
# Cover art


def accent_from_pixbuf(pb):
    small = pb.scale_simple(24, 24, GdkPixbuf.InterpType.BILINEAR)
    px = small.get_pixels()
    n, stride = small.get_n_channels(), small.get_rowstride()
    r = g = b = wsum = 0.0
    for y in range(24):
        for x in range(24):
            i = y * stride + x * n
            pr, pg, pb_ = px[i], px[i + 1], px[i + 2]
            mx, mn = max(pr, pg, pb_), min(pr, pg, pb_)
            sat = 0 if mx == 0 else (mx - mn) / mx
            w = 0.05 + sat * sat * (mx / 255)
            r += pr * w
            g += pg * w
            b += pb_ * w
            wsum += w
    import colorsys
    h, l, s = colorsys.rgb_to_hls(r / wsum / 255, g / wsum / 255, b / wsum / 255)
    if s < 0.12:
        return DEFAULT_ACCENT
    return colorsys.hls_to_rgb(h, min(0.75, max(l, 0.62)), min(1.0, max(s, 0.55)))


class ArtLoader:
    def __init__(self, on_loaded):
        self._on_loaded = on_loaded
        self._current = None
        os.makedirs(CACHE_DIR, exist_ok=True)

    def request(self, url):
        if url == self._current:
            return
        self._current = url
        if not url:
            self._on_loaded(None, DEFAULT_ACCENT)
            return
        threading.Thread(target=self._load, args=(url,), daemon=True).start()

    def _load(self, url):
        pb, color = None, DEFAULT_ACCENT
        try:
            path = None
            if url.startswith('file://'):
                path = Gio.File.new_for_uri(url).get_path()
            elif url.startswith('/'):
                path = url
            elif url.startswith(('http://', 'https://')):
                path = os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest())
                if not os.path.exists(path):
                    with urllib.request.urlopen(url, timeout=10) as r, open(path + '.part', 'wb') as f:
                        shutil.copyfileobj(r, f)
                    os.replace(path + '.part', path)
            if path:
                pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 160, 160, False)
                color = accent_from_pixbuf(pb)
        except Exception as e:  # noqa: BLE001
            print(f'linux-island: cover failed: {e}', file=sys.stderr)
        GLib.idle_add(self._deliver, url, pb, color)

    def _deliver(self, url, pb, color):
        if url == self._current:
            self._on_loaded(pb, color)
        return False


# --------------------------------------------------------------------------
# Drawing helpers


def rounded_rect(cr, x, y, w, h, r):
    r = max(0, min(r, w / 2, h / 2))
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


_icon_cache = {}


def symbolic_icon(name, size, scale):
    key = (name, size, scale)
    if key not in _icon_cache:
        theme = Gtk.IconTheme.get_default()
        info = theme.lookup_icon_for_scale(name, size, scale, Gtk.IconLookupFlags.FORCE_SIZE)
        pb = None
        if info:
            try:
                pb, _ = info.load_symbolic(Gdk.RGBA(1, 1, 1, 1), None, None, None)
            except GLib.Error:
                pb = None
        _icon_cache[key] = pb
    return _icon_cache[key]


def draw_pixbuf(cr, pb, x, y, size, radius=0, alpha=1.0):
    if pb is None:
        return
    cr.save()
    if radius:
        rounded_rect(cr, x, y, size, size, radius)
        cr.clip()
    sx = size / pb.get_width()
    sy = size / pb.get_height()
    cr.translate(x, y)
    cr.scale(sx, sy)
    Gdk.cairo_set_source_pixbuf(cr, pb, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_GOOD)
    cr.paint_with_alpha(alpha)
    cr.restore()


# --------------------------------------------------------------------------
# The island window


class Island(Gtk.Window):
    def __init__(self, app):
        super().__init__(application=app, title='Linux Island')
        self.app = app
        self.cfg = load_config()
        # Everything is laid out at size 1 and scaled when drawn.
        self.s = max(0.7, min(1.6, float(self.cfg.get('scale', 1.0))))
        self.speed = max(0.5, min(2.5, float(self.cfg.get('animation_speed', 1.0))))
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_app_paintable(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_accept_focus(False)
        self.set_default_size(int(WIN_W * self.s), int(WIN_H * self.s))
        self.set_size_request(int(WIN_W * self.s), int(WIN_H * self.s))
        visual = self.get_screen().get_rgba_visual()
        if visual:
            self.set_visual(visual)

        self.layer_shell = False
        if GtkLayerShell and Gdk.Display.get_default().__class__.__name__.startswith('Wayland') \
                and (not hasattr(GtkLayerShell, 'is_supported') or GtkLayerShell.is_supported()):
            GtkLayerShell.init_for_window(self)
            GtkLayerShell.set_namespace(self, 'linux-island')
            GtkLayerShell.set_layer(self, GtkLayerShell.Layer.TOP)
            GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.TOP, True)
            GtkLayerShell.set_margin(self, GtkLayerShell.Edge.TOP, max(0, self.cfg['top_margin'] - int(TOP * self.s)))
            GtkLayerShell.set_exclusive_zone(self, 0)
            GtkLayerShell.set_keyboard_mode(self, GtkLayerShell.KeyboardMode.NONE)
            monitor = self._monitor()
            if self.cfg['monitor'] is not None and monitor:
                GtkLayerShell.set_monitor(self, monitor)
            self.layer_shell = True
        else:
            self.set_type_hint(Gdk.WindowTypeHint.DOCK)
            self.set_keep_above(True)
            self.stick()

        self.area = Gtk.DrawingArea()
        self.area.add_events(Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.BUTTON_PRESS_MASK |
                             Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.SCROLL_MASK |
                             Gdk.EventMask.SMOOTH_SCROLL_MASK |
                             Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        self.area.connect('draw', self._on_draw)
        self.area.connect('motion-notify-event', self._on_motion)
        self.area.connect('leave-notify-event', self._on_leave)
        self.area.connect('button-release-event', self._on_click)
        self.area.connect('scroll-event', self._on_scroll)
        self.add(self.area)

        # state
        self.state = 'idle'
        self.prev_state = None
        self.expanded = False
        self.tools_open = False
        self.hover = False
        self.pointer = (-1, -1)
        self.cur_w, self.cur_h = SIZES['idle']
        self.vel_w = self.vel_h = 0.0
        self.fade = 1.0
        self.opacity_target = 1.0
        self.opacity_cur = 1.0
        self.buttons = []
        self.timeouts = {}
        self.eq = [3.0] * 4
        self.eq_target = [3.0] * 4

        self.art_pb = None
        self.accent = DEFAULT_ACCENT
        self.art = ArtLoader(self._on_art)

        self.queue = []
        self.current = None

        self.timer_end = 0.0
        self.timer_left = 0.0
        self.timer_done = False

        self.mpris = Mpris(self._on_media)
        if self.cfg['show_notifications']:
            self.notifications = NotificationMonitor(self._on_notification)

        self.connect('realize', lambda *_: self._place())
        self.connect('size-allocate', lambda *_: self._update_input())
        self._tick_id = None
        self._update(force=True)

    # ---- geometry ----------------------------------------------------------

    def _monitor(self):
        display = Gdk.Display.get_default()
        idx = self.cfg.get('monitor')
        if isinstance(idx, int) and 0 <= idx < display.get_n_monitors():
            return display.get_monitor(idx)
        return display.get_primary_monitor() or display.get_monitor(0)

    def _place(self):
        if self.layer_shell:
            return
        mon = self._monitor()
        if not mon:
            return
        area = mon.get_workarea()
        self.move(area.x + (area.width - int(WIN_W * self.s)) // 2, area.y + self.cfg['top_margin'] - int(TOP * self.s))

    def island_rect(self):
        w, h = self.cur_w, self.cur_h
        return (WIN_W - w) / 2, TOP, w, h

    def _update_input(self):
        win = self.get_window()
        if not win:
            return
        if self.opacity_target == 0:
            region = cairo.Region()
        else:
            x, y, w, h = (v * self.s for v in self.island_rect())
            region = cairo.Region(cairo.RectangleInt(int(x), int(y), int(math.ceil(w)), int(math.ceil(h))))
        win.input_shape_combine_region(region, 0, 0)

    # ---- state machine -----------------------------------------------------

    def has_media(self):
        return self.cfg['show_media'] and self.mpris.active is not None

    def timer_running(self):
        return self.timer_end > 0 or self.timer_left > 0

    def timer_remaining(self):
        if self.timer_end:
            return max(0.0, (self.timer_end - time.monotonic()) * 1000)
        return self.timer_left

    def compute_state(self):
        if self.timer_done:
            return 'done'
        if self.current:
            return 'notification'
        if self.tools_open:
            return 'idle-open'
        if self.has_media():
            return 'media-open' if self.expanded else 'media'
        if self.expanded:
            return 'idle-open'
        if self.timer_running():
            return 'timer'
        return 'idle'

    def _update(self, force=False):
        state = self.compute_state()
        hidden = state == 'idle' and self.cfg['hide_when_idle']
        self.opacity_target = 0.0 if hidden else 1.0
        if state != self.state or force:
            self.prev_state = self.state if not force else None
            self.state = state
            self.fade = 0.0 if not force else 1.0
        self._start_animation()
        self._update_periodic()
        self.area.queue_draw()

    def _start_animation(self):
        if self._tick_id is None:
            self._last_frame = None
            self._tick_id = self.area.add_tick_callback(self._tick)

    def _tick(self, _widget, clock):
        t = clock.get_frame_time() / 1e6
        dt = 1 / 60 if self._last_frame is None else min(0.05, t - self._last_frame)
        self._last_frame = t
        tw, th = SIZES[self.state]
        k = 330.0 * self.speed ** 2
        c = 2 * math.sqrt(k) * 0.72  # a little bounce
        self.vel_w += ((tw - self.cur_w) * k - self.vel_w * c) * dt
        self.vel_h += ((th - self.cur_h) * k - self.vel_h * c) * dt
        self.cur_w += self.vel_w * dt
        self.cur_h += self.vel_h * dt
        self.fade = min(1.0, self.fade + dt * self.speed / 0.2)
        self.opacity_cur += (self.opacity_target - self.opacity_cur) * min(1.0, dt * 12)
        for i in range(4):
            self.eq[i] += (self.eq_target[i] - self.eq[i]) * min(1.0, dt * 14)
        self._update_input()
        self.area.queue_draw()
        settled = (abs(tw - self.cur_w) < 0.3 and abs(th - self.cur_h) < 0.3 and
                   abs(self.vel_w) < 0.5 and abs(self.vel_h) < 0.5 and self.fade >= 1.0 and
                   abs(self.opacity_target - self.opacity_cur) < 0.01 and
                   all(abs(a - b) < 0.2 for a, b in zip(self.eq, self.eq_target)))
        if settled:
            self.cur_w, self.cur_h = tw, th
            self.opacity_cur = self.opacity_target
            self._update_input()
            self._tick_id = None
            return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE

    def _set_timeout(self, name, ms, cb, repeat=False):
        self._clear_timeout(name)

        def run():
            keep = cb()
            if repeat and keep is not False:
                return GLib.SOURCE_CONTINUE
            self.timeouts.pop(name, None)
            return GLib.SOURCE_REMOVE
        self.timeouts[name] = GLib.timeout_add(ms, run)

    def _clear_timeout(self, name):
        tid = self.timeouts.pop(name, None)
        if tid:
            GLib.source_remove(tid)

    def _update_periodic(self):
        playing = self.mpris.active is not None and self.mpris.active.status == 'Playing'
        if self.state in ('media', 'media-open') and playing:
            if 'eq' not in self.timeouts:
                self._set_timeout('eq', 170, self._bounce_eq, repeat=True)
        else:
            self._clear_timeout('eq')
            self.eq_target = [3.0] * 4
        slow = self.state in ('media-open', 'idle-open', 'timer') or \
            (self.state == 'media' and self.timer_running())
        if slow:
            if 'slow' not in self.timeouts:
                self._set_timeout('slow', 500, self._slow_tick, repeat=True)
        else:
            self._clear_timeout('slow')

    def _bounce_eq(self):
        mx = 20 if self.state == 'media-open' else 14
        self.eq_target = [3 + random.random() * (mx - 3) for _ in range(4)]
        self._start_animation()
        return True

    def _slow_tick(self):
        if self.state == 'media-open' and self.mpris.active and random.random() < 0.17:
            self.mpris.active.refresh_position()
        self.area.queue_draw()
        return True

    # ---- events from sources ---------------------------------------------

    def _on_media(self):
        p = self.mpris.active
        self.art.request(p.art_url if p else '')
        if not self.has_media() and not self.tools_open:
            self.expanded = False
        self._update()

    def _on_art(self, pb, color):
        self.art_pb = pb
        self.accent = color
        self.area.queue_draw()

    def _on_notification(self, body):
        app_name, replaces_id, app_icon, summary, text, _actions, hints, _timeout = body
        if app_name in self.cfg['ignore_apps'] or not self.cfg['show_notifications']:
            return False
        if hints.get('urgency', 1) == 0:  # low urgency never gets a banner
            return False
        n = {
            'app': app_name,
            'title': strip_markup(summary),
            'body': strip_markup(text),
            'icon': notification_pixbuf(app_icon, hints, 76),
            'replaces': replaces_id,
        }
        if self.current and replaces_id and self.current['replaces'] == replaces_id:
            self.current = n
            self._schedule_notification_end()
            self.area.queue_draw()
            return False
        self.queue.append(n)
        if not self.current:
            self._next_notification()
        else:
            self.area.queue_draw()
        return False

    def _next_notification(self):
        self.current = self.queue.pop(0) if self.queue else None
        if self.current:
            self._schedule_notification_end()
        self._update()

    def _schedule_notification_end(self):
        def end():
            if self.hover:
                self._schedule_notification_end()
            else:
                self._next_notification()
        self._set_timeout('notification', self.cfg['notification_duration'] * 1000, end)

    # ---- timer -------------------------------------------------------------

    def start_timer(self, minutes):
        self.timer_end = time.monotonic() + minutes * 60
        self.timer_left = 0
        self._set_timeout('timer', 250, self._timer_tick, repeat=True)
        self.collapse()

    def _timer_tick(self):
        if self.timer_end and self.timer_remaining() <= 0:
            self.timer_end = 0
            self.timer_done = True
            self._play_sound()
            self._set_timeout('done', 20000, self.dismiss_done)
            self._update()
            return False
        return True

    def toggle_timer_pause(self):
        if self.timer_end:
            self.timer_left = self.timer_remaining()
            self.timer_end = 0
            self._clear_timeout('timer')
        elif self.timer_left:
            self.timer_end = time.monotonic() + self.timer_left / 1000
            self.timer_left = 0
            self._set_timeout('timer', 250, self._timer_tick, repeat=True)
        self.area.queue_draw()

    def stop_timer(self):
        self.timer_end = self.timer_left = 0
        self._clear_timeout('timer')
        self._update()

    def dismiss_done(self):
        self._clear_timeout('done')
        self.timer_done = False
        self._update()

    def _play_sound(self):
        for cmd in (['canberra-gtk-play', '-i', 'alarm-clock-elapsed'],
                    ['paplay', '/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga'],
                    ['pw-play', '/usr/share/sounds/freedesktop/stereo/complete.oga']):
            if shutil.which(cmd[0]):
                subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
        Gdk.Display.get_default().beep()

    # ---- input -------------------------------------------------------------

    def _inside(self, x, y):
        ix, iy, w, h = self.island_rect()
        return ix <= x <= ix + w and iy <= y <= iy + h

    def _on_motion(self, _w, event):
        self.pointer = (event.x / self.s, event.y / self.s)
        inside = self._inside(*self.pointer)
        if inside != self.hover:
            self.hover = inside
            self._on_hover()
        self.area.queue_draw()

    def _on_leave(self, _w, _event):
        self.pointer = (-1, -1)
        if self.hover:
            self.hover = False
            self._on_hover()
        self.area.queue_draw()

    def _on_hover(self):
        if self.hover:
            self._clear_timeout('collapse')
            if self.state == 'media' and self.cfg['expand_on_hover']:
                self._set_timeout('expand', int(120 / self.speed), self.expand)
        else:
            self._clear_timeout('expand')
            if self.expanded or self.tools_open:
                self._set_timeout('collapse', int(350 / self.speed), self.collapse)

    def _on_click(self, _w, event):
        ex, ey = event.x / self.s, event.y / self.s
        for (x, y, w, h), cb in self.buttons:
            if x <= ex <= x + w and y <= ey <= y + h:
                if event.button == 1:
                    cb(ex)
                return True
        if not self._inside(ex, ey):
            return False
        if self.state == 'done':
            self.dismiss_done()
        elif self.state == 'notification':
            self._next_notification()
        elif self.state in ('idle', 'timer', 'media'):
            self.expand()
        return True

    def _on_scroll(self, _w, event):
        p = self.mpris.active
        if not p or not self.state.startswith('media'):
            return False
        if event.direction == Gdk.ScrollDirection.LEFT:
            p.previous()
        elif event.direction == Gdk.ScrollDirection.RIGHT:
            p.next()
        return True

    def expand(self):
        self._clear_timeout('expand')
        self.expanded = True
        self._update()
        if not self.hover:
            self._set_timeout('collapse', 4000, self.collapse)

    def collapse(self):
        self._clear_timeout('collapse')
        self.expanded = False
        self.tools_open = False
        self._update()

    def toggle(self):
        if self.state == 'notification':
            self._next_notification()
        elif self.state == 'done':
            self.dismiss_done()
        elif self.expanded or self.tools_open:
            self.collapse()
        else:
            self.expand()
            self._set_timeout('collapse', 8000, lambda: None if self.hover else self.collapse())

    # ---- drawing -----------------------------------------------------------

    def _on_draw(self, widget, cr):
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        cr.scale(self.s, self.s)
        self.buttons = []
        self.scale = max(1, round(widget.get_scale_factor() * self.s + 0.49))

        alpha = self.opacity_cur
        if alpha <= 0.01:
            return
        x, y, w, h = self.island_rect()
        radius = min(h / 2, 26)

        cr.push_group()
        glow = self._glow_color()
        if glow:
            for i in range(10, 0, -1):
                rounded_rect(cr, x - i, y - i + 2, w + 2 * i, h + 2 * i, radius + i)
                cr.set_source_rgba(*glow, 0.035)
                cr.fill()
        rounded_rect(cr, x, y, w, h, radius)
        cr.set_source_rgba(0, 0, 0, 0.96)
        cr.fill_preserve()
        cr.set_source_rgba(1, 1, 1, 0.07)
        cr.set_line_width(1)
        cr.stroke()

        cr.save()
        rounded_rect(cr, x, y, w, h, radius)
        cr.clip()
        if self.prev_state and self.fade < 0.5:
            self._draw_view(cr, self.prev_state, 1 - self.fade * 2, interactive=False)
        if self.fade > 0.25:
            self._draw_view(cr, self.state, (self.fade - 0.25) / 0.75, interactive=self.fade > 0.5)
        cr.restore()
        cr.pop_group_to_source()
        cr.paint_with_alpha(alpha)

    def _glow_color(self):
        if self.state == 'done':
            return TIMER_COLOR
        p = self.mpris.active
        if self.state in ('media', 'media-open') and p and p.status == 'Playing':
            return self.accent
        return None

    def _draw_view(self, cr, state, alpha, interactive):
        vw, vh = SIZES[state]
        cx = WIN_W / 2
        ox = cx - vw / 2
        oy = TOP + (self.cur_h - vh) / 2
        cr.push_group()
        draw = getattr(self, '_draw_' + state.replace('-', '_'))
        draw(cr, ox, oy, vw, vh, interactive)
        cr.pop_group_to_source()
        cr.paint_with_alpha(max(0.0, min(1.0, alpha)))

    def _text(self, cr, text, x, y, width, font, color=(1, 1, 1), alpha=1.0, align='left', valign_h=None):
        layout = PangoCairo.create_layout(cr)
        layout.set_font_description(Pango.FontDescription.from_string(font))
        layout.set_text(text or '', -1)
        layout.set_ellipsize(Pango.EllipsizeMode.END)
        layout.set_width(int(max(1, width) * Pango.SCALE))
        layout.set_single_paragraph_mode(True)
        if align == 'right':
            layout.set_alignment(Pango.Alignment.RIGHT)
        elif align == 'center':
            layout.set_alignment(Pango.Alignment.CENTER)
        _ink, logical = layout.get_pixel_extents()
        if valign_h is not None:
            y = y + (valign_h - logical.height) / 2
        cr.move_to(x, y)
        cr.set_source_rgba(*color, alpha)
        PangoCairo.show_layout(cr, layout)
        return logical.width, logical.height

    def _icon(self, cr, name, x, y, size, alpha=1.0, color=None):
        pb = symbolic_icon(name, size, self.scale)
        if pb is None:
            return
        if color:
            cr.save()
            cr.rectangle(x, y, size, size)
            cr.clip()
            cr.push_group()
            draw_pixbuf(cr, pb, x, y, size)
            mask = cr.pop_group()
            cr.set_source_rgba(*color, alpha)
            cr.mask(mask)
            cr.restore()
        else:
            draw_pixbuf(cr, pb, x, y, size, alpha=alpha)

    def _button(self, cr, rect, cb, interactive, circle=False, bg=None):
        x, y, w, h = rect
        hovered = interactive and x <= self.pointer[0] <= x + w and y <= self.pointer[1] <= y + h
        if bg or hovered:
            if circle:
                cr.arc(x + w / 2, y + h / 2, min(w, h) / 2, 0, 2 * math.pi)
            else:
                rounded_rect(cr, x, y, w, h, h / 2)
            cr.set_source_rgba(1, 1, 1, (bg or 0) + (0.12 if hovered else 0))
            cr.fill()
        if interactive:
            self.buttons.append((rect, cb))

    def _cover(self, cr, x, y, size, radius):
        if self.art_pb:
            draw_pixbuf(cr, self.art_pb, x, y, size, radius)
        else:
            rounded_rect(cr, x, y, size, size, radius)
            cr.set_source_rgba(1, 1, 1, 0.10)
            cr.fill()
            s = int(size * 0.5)
            self._icon(cr, 'audio-x-generic-symbolic', x + (size - s) / 2, y + (size - s) / 2, s, 0.75)

    def _eq(self, cr, x, cy, color, scale=1.0):
        for i, hgt in enumerate(self.eq):
            hgt *= scale
            rounded_rect(cr, x + i * 5, cy - hgt / 2, 3, hgt, 1.5)
            cr.set_source_rgba(*color, 1)
            cr.fill()

    # views

    def _draw_idle(self, cr, x, y, w, h, interactive):
        pass

    def _draw_idle_open(self, cr, x, y, w, h, interactive):
        now = GLib.DateTime.new_now_local()
        self._text(cr, now.format('%H:%M'), x + 18, y + 12, 140, 'Sans Light 22')
        gear = (x + w - 18 - 26, y + 14, 26, 26)
        self._button(cr, gear, lambda _x: self._open_config(), interactive, circle=True)
        self._icon(cr, 'emblem-system-symbolic', gear[0] + 6, gear[1] + 6, 14, 0.6)
        self._text(cr, now.format('%a %-d %b'), x + 150, y + 18, gear[0] - x - 158, 'Sans 9.5',
                   alpha=0.6, align='right')

        row_y = y + 68
        self._icon(cr, 'alarm-symbolic', x + 18, row_y + 7, 18, 0.55)
        if self.timer_running():
            self._text(cr, fmt_ms(self.timer_remaining()), x + 48, row_y, 160, 'Sans Semi-Bold 17',
                       valign_h=32)
            stop = (x + w - 18 - 32, row_y, 32, 32)
            pause = (stop[0] - 40, row_y, 32, 32)
            self._button(cr, pause, lambda _x: self.toggle_timer_pause(), interactive, True, 0.10)
            self._icon(cr, 'media-playback-start-symbolic' if self.timer_left else
                       'media-playback-pause-symbolic', pause[0] + 8, pause[1] + 8, 16)
            self._button(cr, stop, lambda _x: self.stop_timer(), interactive, True, 0.10)
            self._icon(cr, 'process-stop-symbolic', stop[0] + 8, stop[1] + 8, 16)
        else:
            presets = self.cfg['timer_presets'][:6]
            avail = w - 48 - 18
            gap = 8
            bw = (avail - gap * (len(presets) - 1)) / max(1, len(presets))
            for i, m in enumerate(presets):
                r = (x + 48 + i * (bw + gap), row_y + 2, bw, 28)
                self._button(cr, r, lambda _x, m=m: self.start_timer(m), interactive, False, 0.10)
                lbl = f'{m // 60}h' if m >= 60 and m % 60 == 0 else f'{m}m'
                self._text(cr, lbl, r[0], r[1], r[2], 'Sans Semi-Bold 9.5', align='center', valign_h=28)

    def _draw_timer(self, cr, x, y, w, h, interactive):
        self._icon(cr, 'alarm-symbolic', x + 10, y + (h - 15) / 2, 15, color=TIMER_COLOR)
        self._text(cr, fmt_ms(self.timer_remaining()), x + 30, y, w - 42, 'Sans Semi-Bold 10',
                   color=TIMER_COLOR, align='right', valign_h=h)

    def _draw_media(self, cr, x, y, w, h, interactive):
        p = self.mpris.active
        if not p:
            return
        self._cover(cr, x + 6, y + (h - 24) / 2, 24, 7)
        right = 26
        if self.timer_running():
            self._text(cr, fmt_ms(self.timer_remaining()), x + w - 70, y, 60, 'Sans Semi-Bold 10',
                               color=TIMER_COLOR, align='right', valign_h=h)
            right = 70
        else:
            self._eq(cr, x + w - 26, y + h / 2, self.accent)
        title = f'{p.title}  ·  {p.artist}' if p.artist else p.title
        self._text(cr, title, x + 39, y, w - 39 - right - 6, 'Sans Semi-Bold 9.5',
                   alpha=1.0 if p.status == 'Playing' else 0.6, valign_h=h)

    def _draw_media_open(self, cr, x, y, w, h, interactive):
        p = self.mpris.active
        if not p:
            return
        pad = 18
        self._cover(cr, x + pad, y + 14, 64, 14)
        tx = x + pad + 64 + 14
        tw = w - (tx - x) - pad - 30
        self._text(cr, p.title, tx, y + 18, tw, 'Sans Bold 11.5')
        sub = p.artist or p.album
        if sub:
            self._text(cr, sub, tx, y + 38, tw, 'Sans 9.5', alpha=0.65)
        count = len(self.mpris.players)
        src = (p.identity or p.bus_name.replace(MPRIS_PREFIX, '')) + (f'   ⇄ {count}' if count > 1 else '')
        sw, sh = self._text(cr, src, tx, y + 57, tw, 'Sans 8.5', alpha=0.45)
        self._button(cr, (tx - 4, y + 55, sw + 8, sh + 4),
                     lambda _x: self.mpris.cycle() if count > 1 else p.raise_(), interactive)
        self._eq(cr, x + w - pad - 18, y + 46, self.accent, 1.0)

        # progress
        py = y + 98
        known = p.length > 0
        bar = (x + pad + 34, py - 2.5, w - 2 * pad - 68, 5)
        rounded_rect(cr, *bar, 2.5)
        cr.set_source_rgba(1, 1, 1, 0.16 if known else 0.06)
        cr.fill()
        if known:
            frac = max(0.0, min(1.0, p.position / p.length))
            rounded_rect(cr, bar[0], bar[1], bar[2] * frac, bar[3], 2.5)
            cr.set_source_rgba(*self.accent, 1)
            cr.fill()
            self._text(cr, fmt_us(p.position), x + pad - 4, py - 7, 34, 'Sans 7.5', alpha=0.55)
            self._text(cr, fmt_us(p.length), bar[0] + bar[2] + 4, py - 7, 34, 'Sans 7.5', alpha=0.55,
                       align='right')
            if p.can_seek and interactive:
                hit = (bar[0], py - 8, bar[2], 16)
                self.buttons.append((hit, lambda ex: p.seek_to((ex - bar[0]) / bar[2])))

        # controls
        cy = y + 136
        tbtn = (x + pad - 4, cy - 13, 26, 26)
        self._button(cr, tbtn, lambda _x: self._open_tools(), interactive, True)
        self._icon(cr, 'alarm-symbolic', tbtn[0] + 6, tbtn[1] + 6, 14, 0.6)
        cx = x + w / 2
        play = (cx - 18, cy - 18, 36, 36)
        prev = (cx - 18 - 18 - 32, cy - 16, 32, 32)
        nxt = (cx + 18 + 18, cy - 16, 32, 32)
        self._button(cr, prev, lambda _x: p.previous(), interactive and p.can_prev, True)
        self._icon(cr, 'media-skip-backward-symbolic', prev[0] + 6, prev[1] + 6, 20, 1 if p.can_prev else 0.35)
        self._button(cr, play, lambda _x: p.play_pause(), interactive, True, 0.12)
        self._icon(cr, 'media-playback-pause-symbolic' if p.status == 'Playing' else
                   'media-playback-start-symbolic', play[0] + 7, play[1] + 7, 22)
        self._button(cr, nxt, lambda _x: p.next(), interactive and p.can_next, True)
        self._icon(cr, 'media-skip-forward-symbolic', nxt[0] + 6, nxt[1] + 6, 20, 1 if p.can_next else 0.35)

    def _draw_notification(self, cr, x, y, w, h, interactive):
        n = self.current
        if not n:
            return
        if n['icon']:
            draw_pixbuf(cr, n['icon'], x + 14, y + (h - 38) / 2, 38, 10)
        else:
            self._icon(cr, 'dialog-information-symbolic', x + 14, y + (h - 38) / 2, 38)
        tx = x + 14 + 38 + 12
        tw = w - (tx - x) - 16
        more = f'+{len(self.queue)}' if self.queue else ''
        self._text(cr, n['app'], tx, y + 12, tw - 30, 'Sans 8', alpha=0.5)
        if more:
            self._text(cr, more, tx, y + 12, tw, 'Sans 8', alpha=0.5, align='right')
        self._text(cr, n['title'], tx, y + 26, tw, 'Sans Bold 10.5')
        if n['body']:
            self._text(cr, n['body'], tx, y + 45, tw, 'Sans 9.5', alpha=0.72)

    def _draw_done(self, cr, x, y, w, h, interactive):
        self._icon(cr, 'alarm-symbolic', x + 16, y + (h - 22) / 2, 22, color=TIMER_COLOR)
        self._text(cr, "Time's up", x + 48, y, 120, 'Sans Bold 11.5', valign_h=h)
        self._text(cr, 'click to dismiss', x + 150, y, w - 150 - 18, 'Sans 8', alpha=0.5, align='right',
                   valign_h=h)

    def _open_tools(self):
        self.tools_open = True
        self._update()

    def _open_config(self):
        try:
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(CONFIG_PATH, None), None)
        except GLib.Error as e:
            print(f'linux-island: cannot open config: {e.message}', file=sys.stderr)


class App(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.island = None

    def do_command_line(self, command_line):
        args = command_line.get_arguments()[1:]
        if '--quit' in args:
            self.quit()
            return 0
        if self.island is None:
            self.island = Island(self)
            self.island.show_all()
        if '--toggle' in args:
            self.island.toggle()
        return 0


def main():
    if '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
        return 0
    return App().run(sys.argv)


if __name__ == '__main__':
    sys.exit(main())
