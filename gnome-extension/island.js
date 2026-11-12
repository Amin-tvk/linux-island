// The island itself: a black pill under the top bar that morphs between
// idle, now-playing, notification, timer and system views.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {DEFAULT_ACCENT} from './art.js';
import {changeVolume} from './system.js';
import {Aura} from './visualizer.js';
import {callInfo, canReplyViaPhone, idShape, isGenericPhoneMirror, phoneKind, replyViaPhone, sourceApp} from './phone.js';
import {formatNumber} from './telephony.js';
import {formatTime, formatUs} from './timer.js';

// [width, height] of the island in each state, at scale 1.
const SIZES = {
    'idle': [120, 10],
    'idle-open': [380, 150],
    'live': [220, 34],
    'media': [340, 36],
    'media-open': [420, 172],
    'notification': [420, 78],
    'notification-open': [420, 170],
    'list': [420, 320],
    'queue': [420, 320],
    'osd': [280, 38],
    'event': [320, 40],
    'call': [420, 92],
    'done': [300, 52],
};

// Milliseconds at animation speed 1.
const EXPAND_DELAY = 120;
const COLLAPSE_DELAY = 350;
const AUTO_COLLAPSE = 4000;
const GROW_TIME = 300;
const SHRINK_TIME = 230;
const PEEK_TIME = 2800;
const OSD_TIME = 1500;
const SPIN_TIME = 6000;     // one turn of the record
const MARQUEE_SPEED = 28;   // px per second, at scale 1
const MARQUEE_PAUSE = 1800; // rest at the start of each pass
const GHOST_OPACITY = 40;
const GHOST_DWELL = 600;    // hold the pointer still this long to use the island
const GHOST_POLL = 40;
const EVENT_TIME = 3000;

const BATTERY_TEXT = {
    charging: 'Charging',
    full: 'Fully charged',
    unplugged: 'On battery',
    low: 'Battery low',
};

function label(text, styleClass, params = {}) {
    const l = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function rgba([r, g, b], a) {
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function stripMarkup(text) {
    return (text ?? '').replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function notificationText(n) {
    return n.useBodyMarkup ? stripMarkup(n.body) : (n.body ?? '').replace(/\s+/g, ' ').trim();
}

const DONE_COLORS = {
    orange: [255, 159, 67],
    tomato: [255, 99, 71],
    green: [52, 199, 89],
    red: [255, 69, 58],
};

function formatStopwatch(ms) {
    const tenths = Math.floor(ms / 100) % 10;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const pad = n => String(n).padStart(2, '0');
    return m >= 60
        ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}`
        : `${pad(m)}:${pad(s % 60)}.${tenths}`;
}

function timeAgo(datetime) {
    const secs = GLib.DateTime.new_now_local().difference(datetime) / 1e6;
    if (secs < 60)
        return 'now';
    if (secs < 3600)
        return `${Math.floor(secs / 60)}m`;
    if (secs < 86400)
        return `${Math.floor(secs / 3600)}h`;
    return datetime.format('%b %-d');
}

// Rounded cover art; falls back to the player's icon.
const Cover = GObject.registerClass(
class Cover extends St.Bin {
    constructor(size, radius) {
        super({style_class: 'li-cover', width: size, height: size, y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this._size = size;
        this._radius = radius;
        this._record = false;
        this._fallback = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: Math.round(size * 0.5)});
        // The spindle hole of the record.
        const hole = Math.max(4, Math.round(size / 5));
        this._hole = new St.Widget({style_class: 'li-record-hole', width: hole, height: hole,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            style: `border-radius: ${hole / 2}px;`});
        this._spin = new Clutter.PropertyTransition({property_name: 'rotation-angle-z',
            duration: SPIN_TIME, repeat_count: -1, progress_mode: Clutter.AnimationMode.LINEAR});
        this._spin.set_from(0);
        this._spin.set_to(360);
        this._spinning = false;
        this.connect('destroy', () => this.remove_all_transitions());
        this.setArt(null, null);
    }

    // Round, with a hole, turning while @playing: a record on a turntable.
    setRecord(record, playing) {
        if (record !== this._record) {
            this._record = record;
            this.setArt(this._path, this._gicon);
        }
        const spin = record && playing && !!this._path;
        if (spin === this._spinning)
            return;
        this._spinning = spin;
        if (spin) {
            // Carry on from where it stopped.
            const from = this.rotation_angle_z % 360;
            this._spin.set_from(from);
            this._spin.set_to(from + 360);
            this.add_transition('spin', this._spin);
            this._spin.start();
        } else {
            this.remove_transition('spin');
            if (!record)
                this.rotation_angle_z = 0;
        }
    }

    setArt(path, gicon) {
        this._path = path;
        this._gicon = gicon;
        if (path) {
            const uri = GLib.filename_to_uri(path, null).replace(/"/g, '%22');
            const radius = this._record ? this._size / 2 : this._radius;
            this.style = `border-radius: ${radius}px; background-image: url("${uri}"); background-size: cover;`;
            this.child = this._record ? this._hole : null;
        } else {
            this.rotation_angle_z = 0;
            this.style = `border-radius: ${this._radius}px;`;
            this._fallback.gicon = gicon ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
            if (!this.child)
                this.child = this._fallback;
        }
    }
});

// Four little bars that bounce while music plays.
const Equalizer = GObject.registerClass(
class Equalizer extends St.BoxLayout {
    constructor(maxHeight, barWidth) {
        super({style_class: 'li-eq', y_align: Clutter.ActorAlign.CENTER});
        this._max = maxHeight;
        this._min = Math.max(2, Math.round(maxHeight / 5));
        this._bars = [0, 1, 2, 3].map(() => {
            const bar = new St.Widget({
                style_class: 'li-eq-bar',
                width: barWidth,
                height: this._min,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(bar);
            return bar;
        });
        this._id = 0;
        this.connect('destroy', () => this.stop());
    }

    setColor(color) {
        this._bars.forEach(b => (b.style = `background-color: ${rgba(color, 1)};`));
    }

    start() {
        if (this._id)
            return;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 170, () => {
            this._bars.forEach(b => b.ease({
                height: this._min + Math.random() * (this._max - this._min),
                duration: 160,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            }));
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
        this._bars.forEach(b => b.ease({height: this._min, duration: 200}));
    }

    // Driven by the real spectrum instead of random bouncing.
    setLevels(levels) {
        if (this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
        [1, 4, 9, 16].forEach((band, i) => {
            const v = Math.min(1, levels[band] ?? 0);
            this._bars[i].remove_all_transitions();
            this._bars[i].height = Math.round(this._min + v * (this._max - this._min));
        });
    }
});

// A one-line label that scrolls slowly when the text is too long to fit,
// resting at the start of each pass. Takes no width of its own.
const Marquee = GObject.registerClass(
class Marquee extends St.Widget {
    constructor(styleClass, scale) {
        super({x_expand: true, clip_to_allocation: true, y_align: Clutter.ActorAlign.CENTER});
        this._speed = MARQUEE_SPEED * scale;
        this._strip = new St.BoxLayout();
        this._a = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._b = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        for (const l of [this._a, this._b])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._gap = Math.round(40 * scale);
        this._b.style = `margin-left: ${this._gap}px;`;
        this._strip.add_child(this._a);
        this._strip.add_child(this._b);
        this.add_child(this._strip);
        this._running = false;
        this._overflow = false;
        this._laterId = 0;
        this.connect('destroy', () => this._stopPass());
    }

    set text(text) {
        if (this._a.text === text)
            return;
        this._a.text = this._b.text = text;
        this._restart();
    }

    get text() {
        return this._a.text;
    }

    // Scrolls while @running and the text overflows.
    set running(running) {
        if (running === this._running)
            return;
        this._running = running;
        this._restart();
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(forWidth) {
        return this._a.get_preferred_height(forWidth);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [, natW] = this._strip.get_preferred_width(-1);
        const [, natH] = this._strip.get_preferred_height(-1);
        const h = box.get_height();
        const child = new Clutter.ActorBox();
        const y = Math.round((h - natH) / 2);
        child.set_origin(0, y);
        child.set_size(natW, natH);
        this._strip.allocate(child);
        const overflow = this._a.get_preferred_width(-1)[1] > box.get_width() + 1;
        if (overflow !== this._overflow) {
            this._overflow = overflow;
            // Not from inside allocation.
            if (!this._laterId) {
                this._laterId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._laterId = 0;
                    this._restart();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _stopPass() {
        if (this._laterId)
            GLib.source_remove(this._laterId);
        this._laterId = 0;
        if (this._restId)
            GLib.source_remove(this._restId);
        this._restId = 0;
        this._strip.remove_all_transitions();
    }

    _restart() {
        this._stopPass();
        this._strip.translation_x = 0;
        this._b.visible = this._overflow;
        if (this._running && this._overflow)
            this._pass();
    }

    _pass() {
        this._restId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MARQUEE_PAUSE, () => {
            this._restId = 0;
            const distance = this._a.width + this._gap;
            this._strip.ease({
                translation_x: -distance,
                duration: Math.round(distance / this._speed * 1000),
                mode: Clutter.AnimationMode.LINEAR,
                onStopped: finished => {
                    if (!finished)
                        return;
                    this._strip.translation_x = 0;
                    this._pass();
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }
});

// Thin progress bar; click to seek when @seekable.
const Progress = GObject.registerClass({
    Signals: {'seek': {param_types: [GObject.TYPE_DOUBLE]}},
}, class Progress extends St.Widget {
    constructor(styleClass = 'li-progress') {
        super({style_class: styleClass, reactive: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'li-progress-fill'});
        this.add_child(this._fill);
        this._fraction = 0;
        this.connect('button-press-event', (_a, event) => {
            const [x] = event.get_coords();
            const [ax] = this.get_transformed_position();
            this.emit('seek', (x - ax) / Math.max(1, this.width));
            return Clutter.EVENT_STOP;
        });
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const fill = new Clutter.ActorBox();
        fill.set_size(Math.round(box.get_width() * this._fraction), box.get_height());
        this._fill.allocate(fill);
    }

    setColor(color) {
        this._fill.style = `background-color: ${rgba(color, 1)};`;
    }

    set fraction(f) {
        this._fraction = Math.max(0, Math.min(1, f || 0));
        this.queue_relayout();
    }
});

export const Island = GObject.registerClass(
class Island extends St.Widget {
    constructor({settings, mpris, notifications, timer, art, battery, osd, spectrum, reply, extras, openPrefs}) {
        super({
            name: 'linuxIsland',
            style_class: 'li-island',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._settings = settings;
        this._mpris = mpris;
        this._notifications = notifications;
        this._timer = timer;
        this._art = art;
        this._openPrefs = openPrefs;
        this._spectrum = spectrum;
        this._reply = reply;
        this._x = extras;   // bluetooth, privacy, clipboard, calendar, weather, focus, stopwatch, pomodoro, alarms
        this._aura = null;
        this._call = null;  // ongoing phone call {name, start}
        this._done = null;  // {title, subtitle, color}

        this._state = null;
        this._expanded = false;
        this._toolsOpen = false;
        this._listOpen = false;
        this._queueOpen = false;
        this._queueTab = 'queue';
        this._queue = [];
        this._current = null;
        this._replying = false;
        this._grab = null;
        this._osd = null;
        this._event = null;
        this._accent = DEFAULT_ACCENT;
        this._artPath = null;
        this._artRequest = null;
        this._trackKey = null;
        this._timeouts = {};
        this._suspended = false;
        this._bannerShown = false;
        this._scrollAcc = 0;

        this._clip = new St.Widget({
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this.add_child(this._clip);
        // A hairline in the colour of the cover while music plays.
        this._ring = new St.Widget({style_class: 'li-ring', x_expand: true, y_expand: true, opacity: 0});
        this.add_child(this._ring);
        this._ringColor = null;
        this._ghost = null;
        this._ghostSolid = false;
        this._build();

        this.connect('notify::hover', () => this._onHover());
        this.connect('button-press-event', (_a, event) => this._onPress(event));
        this.connect('button-release-event', (_a, event) => this._onClick(event));
        this.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.addChrome(this, {trackFullscreen: true});
        this._aura = new Aura(this, spectrum, this._px(14));
        // The shell may destroy these first when it shuts down.
        this._aura.connect('destroy', () => (this._aura = null));
        this._buildPrivacyDots();
        spectrum.connectObject('levels', (_s, levels) => {
            if (this._state === 'media')
                this._miniEq.setLevels(levels);
            else if (this._state === 'media-open')
                this._bigEq.setLevels(levels);
        }, this);

        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);
        Main.layoutManager.panelBox.connectObject(
            'notify::allocation', () => this._relayout(),
            'notify::visible', () => this._relayout(), this);
        Main.panel.statusArea.dateMenu?.menu.connectObject('open-state-changed',
            (_m, open) => this._setSuspended(open), this);
        // A GNOME banner (critical notifications) sits where the island is.
        Main.messageTray.connectObject('notify::visible', () => {
            this._bannerShown = Main.messageTray.visible;
            this._updateVisibility();
        }, this);

        mpris.connectObject(
            'changed', () => this._onMediaChanged(),
            'position', () => this._syncProgress(), this);
        notifications.connectObject(
            'notification', (_w, n) => this._enqueue(n),
            'history-changed', () => this._onHistoryChanged(), this);
        timer.connectObject(
            'changed', () => this._onTimerChanged(),
            'tick', () => this._syncTimer(),
            'done', () => this._onTimerDone(), this);
        battery.connectObject('event', (_b, ev) => this._onBattery(ev), this);
        this._connectExtras();
        osd.connectObject('osd', (_o, info) => this._showOsd(info), this);
        settings.connectObject('changed', (_s, key) => {
            if (key === 'scale') {
                this._rebuild();
                this._buildPrivacyDots();
            }
            this._relayout();
            this._update();
            this._restyle();
            this._updateTickers();
        }, this);

        this._relayout();
        this._onMediaChanged();
        this._onTimerChanged();
        this._onHistoryChanged();
    }

    // ---- scale -------------------------------------------------------------

    get _scale() {
        return this._settings.get_double('scale');
    }

    _px(n) {
        return Math.round(n * this._scale);
    }

    _size(state) {
        return SIZES[state].map(v => this._px(v));
    }

    _ms(ms) {
        return Math.round(ms / this._settings.get_double('animation-speed'));
    }

    _rebuild() {
        this._clip.destroy_all_children();
        this._build();
        const state = this._state;
        this._state = null;
        this._update();
        if (!state)
            return;
        const [w, h] = this._size(this._state);
        this.remove_all_transitions();
        this.set_size(w, h);
        this._reposition();
    }

    // ---- views -------------------------------------------------------------

    _build() {
        this._views = {};
        this._buildIdle();
        this._buildIdleOpen();
        this._buildTimer();
        this._buildMedia();
        this._buildMediaOpen();
        this._buildNotification();
        this._buildNotificationOpen();
        this._buildList();
        this._buildQueue();
        this._buildOsd();
        this._buildEvent();
        this._buildCall();
        this._buildDone();
        this._syncTimerRows();
        if (!this._state) {
            const [w, h] = this._size('idle');
            this.set_size(w, h);
        }
        this._restyle();
    }

    _addView(name, actor) {
        const [w, h] = this._size(name);
        actor.set({
            width: w,
            height: h,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            visible: false,
        });
        this._clip.add_child(actor);
        this._views[name] = actor;
    }

    _icon(name, size, styleClass = '') {
        return new St.Icon({icon_name: name, icon_size: this._px(size), style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    }

    _iconButton(iconName, styleClass, iconSize, callback) {
        const button = new St.Button({
            style_class: `li-btn ${styleClass}`,
            child: this._icon(iconName, iconSize),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => callback());
        return button;
    }

    _textButton(text, styleClass, callback, params = {}) {
        const button = new St.Button({label: text, style_class: `li-btn ${styleClass}`, y_align: Clutter.ActorAlign.CENTER, ...params});
        button.connect('clicked', () => callback());
        return button;
    }

    _bellButton() {
        const box = new St.BoxLayout({style_class: 'li-bell-box'});
        box.add_child(this._icon('preferences-system-notifications-symbolic', 14));
        const count = label('', 'li-bell-count');
        box.add_child(count);
        const button = new St.Button({style_class: 'li-btn li-small-btn', child: box, y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', () => this._openList());
        this._bellCounts.push(count);
        return button;
    }

    _buildIdle() {
        const box = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._unseenDot = new St.Widget({
            style_class: 'li-dot',
            width: this._px(6),
            height: this._px(6),
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._unseenDot);
        this._addView('idle', box);
    }

    _buildIdleOpen() {
        this._bellCounts = [];
        const box = new St.BoxLayout({style_class: 'li-view li-idle-open', orientation: Clutter.Orientation.VERTICAL});

        const top = new St.BoxLayout({style_class: 'li-row'});
        this._clockLabel = label('', 'li-clock');
        const side = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'li-clock-side'});
        this._dateLabel = label('', 'li-date', {x_align: Clutter.ActorAlign.END});
        const weather = new St.BoxLayout({x_align: Clutter.ActorAlign.END, style_class: 'li-weather'});
        this._weatherIcon = this._icon('weather-clear-symbolic', 14, 'li-dim-icon');
        this._weatherLabel = label('', 'li-date');
        weather.add_child(this._weatherIcon);
        weather.add_child(this._weatherLabel);
        this._weatherBox = weather;
        this._phoneIcon = this._icon('phone-symbolic', 13, 'li-dim-icon');
        this._phoneLabel = label('', 'li-date');
        this._phoneCharge = this._icon('battery-full-charging-symbolic', 12, 'li-battery-ok');
        weather.insert_child_at_index(this._phoneCharge, 0);
        weather.insert_child_at_index(this._phoneLabel, 0);
        weather.insert_child_at_index(this._phoneIcon, 0);
        side.add_child(this._dateLabel);
        side.add_child(weather);
        top.add_child(this._clockLabel);
        top.add_child(side);
        top.add_child(this._bellButton());
        top.add_child(this._iconButton('emblem-system-symbolic', 'li-small-btn', 14, () => {
            this._collapse();
            this._openPrefs();
        }));
        box.add_child(top);

        // Preset buttons when no timer runs, controls when one does.
        this._presetRow = new St.BoxLayout({style_class: 'li-row li-presets', x_expand: true});
        this._timerRow = new St.BoxLayout({style_class: 'li-row', x_expand: true});
        this._timerRowIcon = this._icon('alarm-symbolic', 18, 'li-dim-icon');
        this._timerRowLabel = label('', 'li-timer-big', {x_expand: true});
        this._timerPauseBtn = this._iconButton('media-playback-pause-symbolic', 'li-round-btn', 16, () => {
            if (this._timer.paused)
                this._timer.resume();
            else
                this._timer.pause();
        });
        this._timerRow.add_child(this._timerRowIcon);
        this._timerRow.add_child(this._timerRowLabel);
        this._timerRow.add_child(this._timerPauseBtn);
        this._timerRow.add_child(this._iconButton('process-stop-symbolic', 'li-round-btn', 16, () => {
            if (this._x.pomodoro.active)
                this._x.pomodoro.stop();
            else
                this._timer.stop();
        }));
        box.add_child(this._presetRow);
        box.add_child(this._timerRow);
        this._rebuildPresets();
        this._settings.connectObject('changed::timer-presets', () => this._rebuildPresets(), this);

        // Tools: pomodoro, stopwatch, focus mode, and what's next.
        const tools = new St.BoxLayout({style_class: 'li-row li-tools', x_expand: true});
        this._pomodoroChip = this._textButton('🍅 Pomodoro', 'li-chip', () => {
            if (this._x.pomodoro.active)
                this._x.pomodoro.stop();
            else
                this._x.pomodoro.start();
        });
        this._stopwatchChip = this._textButton('⏱ Stopwatch', 'li-chip', () => this._x.stopwatch.toggle());
        this._stopwatchReset = this._iconButton('edit-undo-symbolic', 'li-small-btn', 12, () => this._x.stopwatch.reset());
        this._focusChip = this._textButton('🌙 Focus', 'li-chip', () => {
            const on = this._x.focus.toggle();
            this._showEvent({
                iconName: 'weather-clear-night-symbolic',
                title: 'Do Not Disturb',
                value: on ? 'On' : 'Off',
                valueClass: on ? 'li-value-focus' : '',
            });
        });
        this._nextLabel = label('', 'li-next', {x_expand: true, x_align: Clutter.ActorAlign.END});
        tools.add_child(this._pomodoroChip);
        tools.add_child(this._stopwatchChip);
        tools.add_child(this._stopwatchReset);
        tools.add_child(this._focusChip);
        tools.add_child(this._nextLabel);
        box.add_child(tools);

        this._addView('idle-open', box);
    }

    _syncTools() {
        const {pomodoro, stopwatch, focus, calendar, alarms} = this._x;
        this._pomodoroChip.label = pomodoro.active ? '🍅 Stop' : '🍅 Pomodoro';
        this._pomodoroChip.style_class = `li-btn li-chip${pomodoro.active ? ' li-chip-tomato' : ''}`;
        this._stopwatchChip.label = stopwatch.active ? `⏱ ${formatStopwatch(stopwatch.elapsed)}` : '⏱ Stopwatch';
        this._stopwatchChip.style_class = `li-btn li-chip${stopwatch.running ? ' li-chip-on' : ''}`;
        this._stopwatchReset.visible = stopwatch.active && !stopwatch.running;
        this._focusChip.style_class = `li-btn li-chip${focus.active ? ' li-chip-focus' : ''}`;

        const parts = [];
        const event = calendar.next;
        if (event) {
            const time = GLib.DateTime.new_from_unix_local(Math.floor(event.date.getTime() / 1000)).format('%H:%M');
            parts.push(`📅 ${time} ${event.summary}`);
        }
        if (alarms.next)
            parts.push(`⏰ ${alarms.next}`);
        this._nextLabel.text = parts.join('   ');

        const showWeather = this._settings.get_boolean('show-weather') && this._x.weather.text;
        this._weatherIcon.visible = this._weatherLabel.visible = !!showWeather;
        if (showWeather) {
            this._weatherLabel.text = this._x.weather.text;
            this._weatherIcon.icon_name = this._x.weather.iconName;
        }
        const phone = this._phoneToShow();
        this._phoneIcon.visible = this._phoneLabel.visible = !!phone;
        this._phoneCharge.visible = !!phone?.charging;
        if (phone)
            this._phoneLabel.text = `${phone.percent}%`;
        const gap = showWeather ? `margin-right: ${this._px(10)}px;` : '';
        this._phoneCharge.style = gap;
        this._phoneLabel.style = phone?.charging ? '' : gap;
        this._weatherBox.visible = !!showWeather || !!phone;
    }

    _rebuildPresets() {
        this._presetRow.destroy_all_children();
        this._presetRow.add_child(this._icon('alarm-symbolic', 18, 'li-dim-icon'));
        for (const min of this._settings.get_value('timer-presets').deepUnpack()) {
            const text = min >= 60 && min % 60 === 0 ? `${min / 60}h` : `${min}m`;
            this._presetRow.add_child(this._textButton(text, 'li-preset', () => {
                this._timer.start(min);
                this._collapse();
            }, {x_expand: true}));
        }
    }

    // Compact "live activity": recording, call, pomodoro, timer, stopwatch.
    _buildTimer() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact'});
        this._liveIcon = this._icon('alarm-symbolic', 15);
        this._liveLabel = label('', 'li-live-label', {x_expand: true});
        this._liveValue = label('', 'li-timer-small');
        this._liveStop = this._iconButton('media-playback-stop-symbolic', 'li-small-btn li-rec-stop', 12, () => this._liveAction?.());
        box.add_child(this._liveIcon);
        box.add_child(this._liveLabel);
        box.add_child(this._liveValue);
        box.add_child(this._liveStop);
        this._addView('live', box);
    }

    _buildMedia() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact'});
        this._miniCover = new Cover(this._px(24), this._px(7));
        this._miniTitle = new Marquee('li-mini-title', this._scale);
        this._miniEq = new Equalizer(this._px(14), this._px(3));
        this._miniTimer = label('', 'li-timer-small');
        this._miniTimer.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._miniPhone = new St.BoxLayout({
            style_class: 'li-mini-phone',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._miniPhoneIcon = this._icon('phone-symbolic', 12, 'li-dim-icon');
        this._miniPhoneLabel = label('', 'li-mini-phone-pct');
        this._miniPhoneLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._miniPhoneCharge = this._icon('battery-full-charging-symbolic', 11, 'li-battery-ok');
        this._miniPhone.add_child(this._miniPhoneIcon);
        this._miniPhone.add_child(this._miniPhoneLabel);
        this._miniPhone.add_child(this._miniPhoneCharge);
        box.add_child(this._miniCover);
        box.add_child(this._miniTitle);
        box.add_child(this._miniTimer);
        box.add_child(this._miniPhone);
        box.add_child(this._miniEq);
        this._addView('media', box);
    }

    _buildMediaOpen() {
        const box = new St.BoxLayout({style_class: 'li-view li-media-open', orientation: Clutter.Orientation.VERTICAL});

        const top = new St.BoxLayout({style_class: 'li-row'});
        this._cover = new Cover(this._px(64), this._px(14));
        const coverButton = new St.Button({child: this._cover, style_class: 'li-cover-btn'});
        coverButton.connect('clicked', () => this._mpris.active?.raise());
        const info = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'li-info'});
        this._title = label('', 'li-title');
        this._artist = label('', 'li-artist');
        this._sourceBtn = new St.Button({style_class: 'li-source', x_align: Clutter.ActorAlign.START});
        const sourceBox = new St.BoxLayout({style_class: 'li-source-box'});
        this._sourceIcon = new St.Icon({icon_size: this._px(12)});
        this._sourceLabel = label('', 'li-source-label');
        sourceBox.add_child(this._sourceIcon);
        sourceBox.add_child(this._sourceLabel);
        this._sourceBtn.child = sourceBox;
        this._sourceBtn.connect('clicked', () => {
            if (this._mpris.players.length > 1)
                this._mpris.cycle();
            else
                this._mpris.active?.raise();
        });
        info.add_child(this._title);
        info.add_child(this._artist);
        info.add_child(this._sourceBtn);
        this._bigEq = new Equalizer(this._px(20), this._px(3));
        top.add_child(coverButton);
        top.add_child(info);
        top.add_child(this._bigEq);
        box.add_child(top);

        const prog = new St.BoxLayout({style_class: 'li-row li-progress-row'});
        this._posLabel = label('0:00', 'li-time');
        this._lenLabel = label('0:00', 'li-time');
        this._progress = new Progress();
        this._progress.connect('seek', (_p, f) => {
            this._mpris.active?.seekTo(f);
            this._syncProgress();
        });
        prog.add_child(this._posLabel);
        prog.add_child(this._progress);
        prog.add_child(this._lenLabel);
        box.add_child(prog);

        const ctrl = new St.BoxLayout({style_class: 'li-row li-controls', x_align: Clutter.ActorAlign.FILL});
        const timerBtn = this._iconButton('alarm-symbolic', 'li-small-btn', 14, () => {
            this._toolsOpen = true;
            this._update();
        });
        const center = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.CENTER, style_class: 'li-ctrl-center'});
        this._prevBtn = this._iconButton('media-skip-backward-symbolic', 'li-ctrl', 20, () => this._mpris.active?.previous());
        this._playBtn = this._iconButton('media-playback-start-symbolic', 'li-ctrl li-play', 22, () => this._mpris.active?.playPause());
        this._nextBtn = this._iconButton('media-skip-forward-symbolic', 'li-ctrl', 20, () => this._mpris.active?.next());
        center.add_child(this._prevBtn);
        center.add_child(this._playBtn);
        center.add_child(this._nextBtn);
        this._queueBtn = this._iconButton('view-list-symbolic', 'li-small-btn', 14, () => this._openQueue());
        this._queueSpacer = new St.Widget({width: this._px(26)});
        ctrl.add_child(timerBtn);
        ctrl.add_child(this._queueBtn);
        ctrl.add_child(center);
        ctrl.add_child(this._queueSpacer);
        ctrl.add_child(this._bellButton());
        box.add_child(ctrl);

        this._addView('media-open', box);
    }

    _buildNotification() {
        const box = new St.BoxLayout({style_class: 'li-view li-notification'});
        this._notifIcon = new St.Icon({icon_size: this._px(38), style_class: 'li-notif-icon', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const header = new St.BoxLayout();
        this._notifApp = label('', 'li-notif-app', {x_expand: true});
        this._notifCount = label('', 'li-notif-app');
        header.add_child(this._notifApp);
        header.add_child(this._notifCount);
        this._notifTitle = label('', 'li-notif-title');
        this._notifBody = label('', 'li-notif-body');
        text.add_child(header);
        text.add_child(this._notifTitle);
        text.add_child(this._notifBody);
        box.add_child(this._notifIcon);
        box.add_child(text);
        this._addView('notification', box);
    }

    _buildNotificationOpen() {
        const box = new St.BoxLayout({style_class: 'li-view li-notification-open', orientation: Clutter.Orientation.VERTICAL});

        const top = new St.BoxLayout({style_class: 'li-row', y_expand: true});
        this._bigNotifIcon = new St.Icon({icon_size: this._px(38), style_class: 'li-notif-icon', y_align: Clutter.ActorAlign.START});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._bigNotifApp = label('', 'li-notif-app');
        this._bigNotifTitle = label('', 'li-notif-title');
        this._bigNotifBody = new St.Label({style_class: 'li-notif-body', y_expand: true});
        this._bigNotifBody.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
        });
        text.add_child(this._bigNotifApp);
        text.add_child(this._bigNotifTitle);
        text.add_child(this._bigNotifBody);
        top.add_child(this._bigNotifIcon);
        top.add_child(text);
        box.add_child(top);

        // Either the action buttons or the reply entry.
        this._actionRow = new St.BoxLayout({style_class: 'li-row li-actions'});
        box.add_child(this._actionRow);

        this._replyRow = new St.BoxLayout({style_class: 'li-row li-reply-row', visible: false});
        this._replyEntry = new St.Entry({style_class: 'li-entry', x_expand: true, can_focus: true});
        this._replyEntry.clutter_text.connect('activate', () => this._sendReply());
        this._replyEntry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._endReply();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._replyRow.add_child(this._replyEntry);
        this._replyRow.add_child(this._iconButton('mail-send-symbolic', 'li-round-btn li-send', 16, () => this._sendReply()));
        box.add_child(this._replyRow);

        this._addView('notification-open', box);
    }

    _buildList() {
        const box = new St.BoxLayout({style_class: 'li-view li-list', orientation: Clutter.Orientation.VERTICAL});
        const header = new St.BoxLayout({style_class: 'li-row'});
        header.add_child(label('Notifications', 'li-title', {x_expand: true}));
        this._listClear = this._textButton('Clear all', 'li-chip', () => this._notifications.clearHistory());
        header.add_child(this._listClear);
        header.add_child(this._iconButton('window-close-symbolic', 'li-small-btn', 14, () => this._collapse()));
        box.add_child(header);

        this._listBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'li-list-box', x_expand: true});
        this._listScroll = new St.ScrollView({
            style_class: 'li-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._listBox,
        });
        box.add_child(this._listScroll);
        this._listEmpty = label('No notifications', 'li-empty', {x_align: Clutter.ActorAlign.CENTER, y_expand: true, visible: false});
        box.add_child(this._listEmpty);
        this._addView('list', box);
    }

    _buildQueue() {
        const box = new St.BoxLayout({style_class: 'li-view li-list', orientation: Clutter.Orientation.VERTICAL});
        const header = new St.BoxLayout({style_class: 'li-row'});
        header.add_child(this._iconButton('go-previous-symbolic', 'li-small-btn', 14, () => {
            this._queueOpen = false;
            this._expanded = true;
            this._update();
        }));
        this._queueTitle = label('Up next', 'li-title', {x_expand: true});
        header.add_child(this._queueTitle);
        this._queueTabs = new St.BoxLayout({style_class: 'li-tabs'});
        this._queueTabQueue = this._textButton('Queue', 'li-chip', () => this._setQueueTab('queue'));
        this._queueTabLists = this._textButton('Playlists', 'li-chip', () => this._setQueueTab('playlists'));
        this._queueTabs.add_child(this._queueTabQueue);
        this._queueTabs.add_child(this._queueTabLists);
        header.add_child(this._queueTabs);
        box.add_child(header);

        this._queueBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'li-list-box', x_expand: true});
        this._queueScroll = new St.ScrollView({
            style_class: 'li-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._queueBox,
        });
        box.add_child(this._queueScroll);
        this._queueEmpty = label('', 'li-empty', {x_align: Clutter.ActorAlign.CENTER, y_expand: true, visible: false});
        box.add_child(this._queueEmpty);
        this._addView('queue', box);
    }

    _buildOsd() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact li-osd'});
        this._osdIcon = new St.Icon({icon_size: this._px(17), y_align: Clutter.ActorAlign.CENTER});
        this._osdBar = new Progress('li-progress li-osd-bar');
        this._osdBar.reactive = false;
        this._osdLabel = label('', 'li-osd-label', {x_expand: true});
        this._osdValue = label('', 'li-osd-value');
        box.add_child(this._osdIcon);
        box.add_child(this._osdBar);
        box.add_child(this._osdLabel);
        box.add_child(this._osdValue);
        this._addView('osd', box);
    }

    // Short system events: battery, Bluetooth, clipboard, meetings, focus.
    _buildEvent() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact li-osd'});
        this._eventIcon = new St.Icon({icon_size: this._px(18), y_align: Clutter.ActorAlign.CENTER});
        this._eventLabel = label('', 'li-osd-label', {x_expand: true});
        this._eventValue = label('', 'li-event-value');
        this._eventValue.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(this._eventIcon);
        box.add_child(this._eventLabel);
        box.add_child(this._eventValue);
        this._addView('event', box);
    }

    // Incoming phone call (GSConnect).
    _buildCall() {
        const box = new St.BoxLayout({style_class: 'li-view li-call'});
        this._callIcon = new St.Icon({icon_size: this._px(44), style_class: 'li-call-avatar', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._callName = label('', 'li-call-name');
        this._callSub = label('Incoming call', 'li-call-sub');
        text.add_child(this._callName);
        text.add_child(this._callSub);
        this._callMute = this._iconButton('audio-volume-muted-symbolic', 'li-round-btn li-call-mute', 18, () => {
            const mute = this._current?.actions[0];
            mute?.activate();
            this._callSub.text = 'Muted';
        });
        this._callDismiss = this._iconButton('window-close-symbolic', 'li-round-btn', 16, () => this._nextNotification());
        // Bluetooth calls can be answered right here.
        this._callDecline = this._iconButton('call-stop-symbolic', 'li-round-btn li-call-decline', 18, () => {
            const call = this._x.btCalls.ringing;
            if (call)
                this._x.btCalls.hangup(call.path);
        });
        this._callAnswer = this._iconButton('call-start-symbolic', 'li-round-btn li-call-answer', 18, () => {
            const call = this._x.btCalls.ringing;
            if (call)
                this._x.btCalls.answer(call.path);
        });
        box.add_child(this._callIcon);
        box.add_child(text);
        box.add_child(this._callMute);
        box.add_child(this._callDismiss);
        box.add_child(this._callDecline);
        box.add_child(this._callAnswer);
        this._addView('call', box);
    }

    _buildDone() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact li-done'});
        this._doneIcon = this._icon('alarm-symbolic', 22, 'li-accent-icon');
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._doneTitle = label("Time's up", 'li-done-label');
        this._doneSub = label('', 'li-notif-app');
        text.add_child(this._doneTitle);
        text.add_child(this._doneSub);
        box.add_child(this._doneIcon);
        box.add_child(text);
        box.add_child(label('click to dismiss', 'li-notif-app'));
        this._addView('done', box);
    }

    // Tiny coloured dots right of the island while the microphone (orange),
    // camera (green) or screen recording (red) is in use.
    _buildPrivacyDots() {
        this._privacy?.destroy();
        // Fixed layout: the uiGroup gives loose actors no allocation of their own.
        const dots = new St.Widget({style_class: 'li-privacy', reactive: false, opacity: 0});
        const dot = cls => {
            const d = new St.Widget({style_class: `li-pdot ${cls}`, visible: false});
            d.set_size(this._px(7), this._px(7));
            dots.add_child(d);
            return d;
        };
        this._dotRec = dot('li-pdot-rec');
        this._dotMic = dot('li-pdot-mic');
        this._dotCam = dot('li-pdot-cam');
        this._privacyX = new Clutter.SnapConstraint({source: this, from_edge: Clutter.SnapEdge.LEFT, to_edge: Clutter.SnapEdge.RIGHT, offset: this._px(6)});
        this._privacyY = new Clutter.SnapConstraint({source: this, from_edge: Clutter.SnapEdge.TOP, to_edge: Clutter.SnapEdge.TOP, offset: 0});
        dots.add_constraint(this._privacyX);
        dots.add_constraint(this._privacyY);
        Main.layoutManager.uiGroup.insert_child_above(dots, this);
        this.bind_property('visible', dots, 'visible', GObject.BindingFlags.SYNC_CREATE);
        dots.connect('destroy', () => {
            if (this._privacy === dots)
                this._privacy = null;
        });
        this._privacy = dots;
        this._syncPrivacy();
    }

    _syncPrivacy() {
        if (!this._privacy)
            return;
        const p = this._x.privacy;
        const show = this._settings.get_boolean('show-privacy');
        this._dotRec.visible = show && p.recording;
        this._dotMic.visible = show && p.mic;
        this._dotCam.visible = show && p.camera;
        const shown = [this._dotRec, this._dotMic, this._dotCam].filter(d => d.visible);
        const size = this._px(7), gap = this._px(4);
        shown.forEach((d, i) => d.set_position(i * (size + gap), 0));
        this._privacy.set_size(Math.max(1, shown.length * (size + gap) - gap), size);
        const any = shown.length > 0;
        const [, h] = this._size(this._state ?? 'idle');
        this._privacyY.offset = Math.round((Math.min(h, this._px(36)) - this._px(7)) / 2);
        const hidden = this.opacity === 0 && !this.reactive;
        this._privacy.ease({opacity: any && !hidden ? 255 : 0, duration: 200});
    }

    // ---- extra sources -----------------------------------------------------

    _connectExtras() {
        const {bluetooth, privacy, clipboard, calendar, weather, focus, stopwatch, pomodoro, alarms} = this._x;
        bluetooth.connectObject('event', (_b, ev) => {
            // The phone reconnects often; it has its own battery alerts.
            if (!this._settings.get_boolean('show-bluetooth') || ev.iconName === 'phone-symbolic')
                return;
            const connected = ev.kind === 'bt-connected';
            this._showEvent({
                iconName: ev.iconName,
                title: ev.name,
                value: connected ? (ev.percent !== null ? `${ev.percent}%` : 'Connected') : 'Disconnected',
                valueClass: connected ? (ev.percent !== null && ev.percent <= 20 ? 'li-battery-low' : 'li-battery-ok') : '',
            });
        }, this);
        privacy.connectObject('changed', () => {
            this._syncPrivacy();
            this._syncLive();
            this._update();
        }, this);
        clipboard.connectObject('copied', (_c, {text, image}) => {
            if (!this._settings.get_boolean('clipboard-peek'))
                return;
            const preview = image ? 'Image' : text.replace(/\s+/g, ' ').trim().slice(0, 80);
            this._showEvent({iconName: 'edit-copy-symbolic', title: preview, value: 'Copied', valueClass: 'li-value-dim', duration: 1600});
        }, this);
        calendar.connectObject(
            'reminder', (_c, ev) => {
                this._showEvent({
                    iconName: 'x-office-calendar-symbolic',
                    title: ev.summary,
                    value: ev.minutes > 0 ? `in ${ev.minutes} min` : 'now',
                    valueClass: 'li-value-cal',
                    duration: 10000,
                    onClick: () => calendar.openCalendar(),
                });
                global.display.get_sound_player().play_from_theme('message-new-instant', 'Meeting', null);
            },
            'changed', () => this._syncToolsIfOpen(), this);
        weather.connectObject('changed', () => this._syncToolsIfOpen(), this);
        this._focusId = focus.connect(() => this._syncToolsIfOpen());
        stopwatch.connectObject('changed', () => {
            this._syncToolsIfOpen();
            this._syncLive();
            this._update();
        }, this);
        pomodoro.connectObject(
            'changed', () => {
                this._syncToolsIfOpen();
                this._syncTimerRows();
                this._update();
            },
            'phase-done', (_p, {next, minutes}) => {
                const focusNext = next === 'focus';
                this._showDone({
                    iconName: focusNext ? 'alarm-symbolic' : 'weather-clear-symbolic',
                    title: focusNext ? 'Back to focus' : next === 'long-break' ? 'Long break' : 'Break time',
                    subtitle: `${minutes} min`,
                    color: focusNext ? 'tomato' : 'green',
                    sound: 'complete',
                    timeout: 8000,
                });
            }, this);
        alarms.connectObject('ring', (_a, {time}) => {
            this._showDone({
                iconName: 'alarm-symbolic',
                title: 'Alarm',
                subtitle: time,
                color: 'orange',
                sound: 'alarm-clock-elapsed',
                repeat: true,
                timeout: 60000,
            });
        }, this);
        this._settings.connectObject('changed::alarms', () => this._syncToolsIfOpen(), this);
        this._x.btCalls.connectObject('changed', () => this._onBtCalls(), this);
        this._x.gsconnect.connectObject(
            'changed', () => {
                this._onPhoneStatusChanged();
                this._checkPhoneBattery();
            },
            'charging', (_w, {name, level}) => this._showPhoneEvent({
                iconName: 'battery-good-charging-symbolic',
                title: `${name} charging`,
                value: `${level}%`,
                valueClass: 'li-battery-ok',
                iconClass: 'li-battery-ok',
            }), this);
        this._x.phoneBattery.connectObject('changed', () => {
            this._onPhoneStatusChanged();
            this._checkPhoneBattery();
        }, this);
        this._phoneWarned = new Set();
    }

    _showPhoneEvent(ev) {
        if (!this._settings.get_boolean('show-phone'))
            return;
        this._showEvent(ev);
    }

    // The phone's battery from GSConnect (knows charging) or Bluetooth.
    _phoneStatus() {
        const gsc = this._x.gsconnect.phone;
        if (gsc && gsc.level >= 0)
            return {name: gsc.name, percent: gsc.level, charging: gsc.charging, signalIcon: gsc.signalIcon};
        const bt = this._x.phoneBattery.phones[0];
        return bt ? {name: bt.model, percent: bt.percent, charging: false, signalIcon: null} : null;
    }

    // The phone is shown only when it needs attention: low or charging.
    _phoneToShow() {
        if (!this._settings.get_boolean('show-phone'))
            return null;
        const phone = this._phoneStatus();
        const low = Math.max(this._settings.get_int('phone-battery-warning'), 20);
        return phone && (phone.charging || phone.percent <= low) ? phone : null;
    }

    _onPhoneStatusChanged() {
        this._syncToolsIfOpen();
        this._syncMediaPhone();
        if (this._state === 'media')
            this._reposition();
    }

    // Compact media trailing chip: phone % (+ charging bolt).
    _syncMediaPhone() {
        if (!this._miniPhone)
            return;
        const phone = this._phoneToShow();
        this._miniPhone.visible = !!phone;
        if (!phone)
            return;
        this._miniPhoneLabel.text = `${phone.percent}%`;
        this._miniPhoneCharge.visible = !!phone.charging;
        const low = phone.percent <= 20 && !phone.charging;
        this._miniPhoneLabel.style_class = `li-mini-phone-pct${low ? ' li-battery-low' : phone.charging ? ' li-battery-ok' : ''}`;
    }

    // A hard-to-miss alert when the phone runs low, at the threshold and
    // again at 10%, so it gets plugged in in time.
    _checkPhoneBattery() {
        const threshold = this._settings.get_int('phone-battery-warning');
        const phone = this._phoneStatus();
        if (!phone || threshold <= 0 || !this._settings.get_boolean('show-phone'))
            return;
        if (phone.charging || phone.percent > threshold) {
            this._phoneWarned.clear();
            return;
        }
        const level = phone.percent <= Math.min(10, threshold) ? Math.min(10, threshold) : threshold;
        if (this._phoneWarned.has(level))
            return;
        [threshold, Math.min(10, threshold)].filter(l => l >= level).forEach(l => this._phoneWarned.add(l));
        this._showDone({
            iconName: 'battery-caution-symbolic',
            title: `${phone.name}: ${phone.percent}%`,
            subtitle: 'Phone battery low – plug it in',
            color: 'red',
            sound: 'dialog-warning',
            timeout: 60000,
        });
    }

    // Bluetooth calls; GSConnect's notifications for the same call are
    // dropped so it isn't shown twice.
    _onBtCalls() {
        const ringing = this._x.btCalls.ringing;
        if (ringing) {
            if (phoneKind(this._current) === 'call')
                this._nextNotification();
            this._queue.filter(n => phoneKind(n) === 'call').forEach(n => this._dropNotification(n));
            this._callName.text = ringing.name || formatNumber(ringing.number) || 'Unknown caller';
            this._callSub.text = ringing.state === 'waiting' ? 'Call waiting' : 'Incoming call';
            this._callIcon.gicon = new Gio.ThemedIcon({name: 'call-start-symbolic'});
            this._showCallButtons(true);
        }
        this._syncLive();
        this._update();
        this._restyle();
    }

    _showCallButtons(bluetooth) {
        this._callAnswer.visible = bluetooth;
        this._callDecline.visible = bluetooth;
        this._callMute.visible = !bluetooth && (this._current?.actions.length ?? 0) > 0;
        this._callDismiss.visible = !bluetooth;
    }

    _syncToolsIfOpen() {
        if (this._state === 'idle-open')
            this._syncTools();
    }

    // What the compact "live" view shows, most important first.
    _liveInfo() {
        const {privacy, pomodoro, stopwatch} = this._x;
        const now = GLib.get_monotonic_time();
        if (privacy.recording) {
            return {icon: 'media-record-symbolic', text: 'Recording', value: formatTime((now - privacy.recordingStart) / 1000),
                color: 'rec', action: {icon: 'media-playback-stop-symbolic', run: () => privacy.stopRecording()}};
        }
        const bt = this._x.btCalls.live;
        if (bt) {
            const talking = bt.state === 'active' && bt.start;
            return {icon: 'call-start-symbolic', text: bt.name || formatNumber(bt.number) || 'Call',
                value: talking ? formatTime((now - bt.start) / 1000) : bt.state === 'held' ? 'On hold' : 'Calling…',
                color: 'call', action: {icon: 'call-stop-symbolic', run: () => this._x.btCalls.hangup(bt.path)}};
        }
        if (this._call) {
            return {icon: 'call-start-symbolic', text: this._call.name, value: formatTime((now - this._call.start) / 1000),
                color: 'call'};
        }
        if (this._timer.running) {
            if (pomodoro.active) {
                const label = pomodoro.phase === 'focus' ? `Focus ${pomodoro.round % pomodoro.rounds + 1}/${pomodoro.rounds}` : 'Break';
                return {icon: null, text: `🍅 ${label}`, value: formatTime(this._timer.remaining),
                    color: pomodoro.phase === 'focus' ? 'tomato' : 'green'};
            }
            return {icon: 'alarm-symbolic', text: '', value: formatTime(this._timer.remaining), color: 'orange'};
        }
        if (stopwatch.running)
            return {icon: null, text: '⏱', value: formatStopwatch(stopwatch.elapsed), color: 'white'};
        return null;
    }

    _syncLive() {
        const info = this._liveInfo();
        const color = info ? `li-live-${info.color}` : '';
        this._liveIcon.visible = !!info?.icon;
        if (info?.icon)
            this._liveIcon.icon_name = info.icon;
        this._liveIcon.style_class = color;
        this._liveLabel.text = info?.text ?? '';
        this._liveValue.text = info?.value ?? '';
        this._liveValue.style_class = `li-timer-small ${color}`;
        this._liveStop.visible = !!info?.action;
        this._liveAction = info?.action?.run ?? null;
        if (info?.action)
            this._liveStop.child.icon_name = info.action.icon;
        // Media keeps its own view; the live value sits at its right.
        this._miniTimer.text = info ? (info.text && info.color === 'rec' ? `● ${info.value}` : info.value) : '';
        this._miniTimer.style_class = `li-timer-small ${color}`;
        this._miniTimer.visible = !!info;
        this._miniEq.visible = !info;
    }

    _onBattery(ev) {
        if (!this._settings.get_boolean('show-battery'))
            return;
        const color = ev.kind === 'low' ? 'li-battery-low' : ev.kind === 'unplugged' ? '' : 'li-battery-ok';
        this._showEvent({iconName: ev.iconName, title: BATTERY_TEXT[ev.kind] ?? '', value: `${ev.percent}%`, valueClass: color, iconClass: color});
    }

    // ---- state machine -----------------------------------------------------

    _hasMedia() {
        return this._settings.get_boolean('show-media') && this._mpris.active !== null;
    }

    _computeState() {
        if (this._done)
            return 'done';
        if (this._x.btCalls.ringing && this._settings.get_boolean('show-phone'))
            return 'call';
        if (this._current && phoneKind(this._current) === 'call')
            return 'call';
        // Volume/brightness must interrupt banners and media, otherwise a
        // stuck notification (or phone spam) hides the OSD entirely.
        if (this._osd)
            return 'osd';
        if (this._current)
            return this._expanded || this._replying ? 'notification-open' : 'notification';
        if (this._event)
            return 'event';
        if (this._listOpen)
            return 'list';
        if (this._queueOpen && this._hasMedia())
            return 'queue';
        if (this._toolsOpen)
            return 'idle-open';
        if (this._hasMedia())
            return this._expanded ? 'media-open' : 'media';
        if (this._expanded)
            return 'idle-open';
        if (this._liveInfo())
            return 'live';
        return 'idle';
    }

    _update() {
        const state = this._computeState();
        this._syncState(state);
        if (state === this._state)
            return;
        const old = this._state;
        this._state = state;
        if (state !== 'media')
            this._endGhost(false);

        const [w, h] = this._size(state);
        const growing = !old || w * h >= SIZES[old][0] * SIZES[old][1] * this._scale ** 2;
        this.remove_transition('width');
        this.remove_transition('height');
        this.remove_transition('x');
        this._restyle(false); // no glow while resizing: it is re-rendered every frame
        this.ease({
            x: this._xFor(w),
            width: w,
            height: h,
            duration: this._ms(growing ? GROW_TIME : SHRINK_TIME),
            mode: growing ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: finished => {
                if (finished)
                    this._restyle();
            },
        });

        for (const [name, view] of Object.entries(this._views)) {
            if (name === state) {
                view.show();
                view.remove_all_transitions();
                view.ease({
                    opacity: 255,
                    duration: this._ms(160),
                    delay: old ? this._ms(40) : 0,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else if (view.visible) {
                view.remove_all_transitions();
                view.ease({
                    opacity: 0,
                    duration: this._ms(80),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        if (this._state !== name)
                            view.hide();
                    },
                });
            }
        }

        this._updateVisibility();
        this._updateTickers();
    }

    // Refresh the contents of the view for @state.
    _syncState(state) {
        if (state === 'idle-open') {
            this._syncClock();
            this._syncTools();
        }
        if (state === 'live' || state === 'idle-open' || state === 'media')
            this._syncLive();
        if (state === 'media' || state === 'media-open') {
            this._syncMedia();
            this._syncMediaPhone();
        }
        if (state === 'list')
            this._syncList();
    }

    _updateVisibility() {
        const hidden = this._suspended || this._bannerShown ||
            (this._state === 'idle' && this._settings.get_boolean('hide-when-idle'));
        // A ghost lets clicks through to the window below.
        this.reactive = !hidden && !this._ghost;
        this._notifications.blocked = this._suspended;
        this.ease({opacity: hidden ? 0 : this._ghost ? GHOST_OPACITY : 255,
            duration: this._ms(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (this._views)
            this._updateTickers();
        this._syncPrivacy();
    }

    _setSuspended(suspended) {
        this._suspended = suspended;
        if (suspended)
            this._collapse();
        this._updateVisibility();
    }

    // Periodic refreshes only run while the view that needs them is shown.
    _updateTickers() {
        const playing = this._mpris.active?.status === 'Playing';
        const mode = this._settings.get_boolean('visualizer-enabled')
            ? this._settings.get_string('visualizer') : 'off';
        const showing = this._state?.startsWith('media') && playing &&
            !this._suspended && !this._bannerShown;
        // The spectrum drives the aura and the small equalizer bars; with the
        // visualizer off nothing records and the bars bounce randomly.
        if (showing && this._spectrum.available && mode !== 'off')
            this._spectrum.start();
        else
            this._spectrum.stop();
        if (this._aura) {
            this._aura.mode = mode;
            this._aura.active = showing && mode !== 'off';
        }
        const compact = this._state === 'media' && playing && !this._suspended && !this._bannerShown;
        this._miniTitle.running = compact;
        this._miniCover.setRecord(this._settings.get_boolean('vinyl'), compact);
        this._syncRing();
        const real = this._spectrum.running;
        if (this._state === 'media' && playing && !real)
            this._miniEq.start();
        else if (!real || this._state !== 'media')
            this._miniEq.stop();
        if (this._state === 'media-open' && playing && !real)
            this._bigEq.start();
        else if (!real || this._state !== 'media-open')
            this._bigEq.stop();

        if (this._state === 'media-open') {
            this._mpris.active?.refreshPosition();
            this._setTimeout('progress', 500, () => {
                this._syncProgress();
                return GLib.SOURCE_CONTINUE;
            });
            this._setTimeout('poll', 3000, () => {
                this._mpris.active?.refreshPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._clearTimeout('progress');
            this._clearTimeout('poll');
        }

        if (this._state === 'idle-open') {
            this._setTimeout('clock', 1000, () => {
                this._syncClock();
                this._syncTools();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._clearTimeout('clock');
        }

        // Live values that change every second (stopwatch, call, recording).
        const ticking = this._x.stopwatch.running || this._x.privacy.recording || this._call || this._x.btCalls.live;
        if (ticking && ['live', 'media', 'idle-open'].includes(this._state)) {
            this._setTimeout('live', 500, () => {
                this._syncLive();
                if (this._state === 'idle-open')
                    this._syncTools();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._clearTimeout('live');
        }
    }

    _setTimeout(name, ms, callback) {
        if (this._timeouts[name])
            return;
        this._timeouts[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const ret = callback();
            if (ret === GLib.SOURCE_REMOVE)
                delete this._timeouts[name];
            return ret;
        });
    }

    _clearTimeout(name) {
        if (this._timeouts[name])
            GLib.source_remove(this._timeouts[name]);
        delete this._timeouts[name];
    }

    _restartTimeout(name, ms, callback) {
        this._clearTimeout(name);
        this._setTimeout(name, ms, () => {
            delete this._timeouts[name];
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- geometry & style --------------------------------------------------

    _relayout() {
        const index = this._settings.get_int('monitor');
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const panel = Main.layoutManager.panelBox;
        let top = monitor.y;
        if (panel.visible && panel.height > 0 && Math.abs(panel.y - monitor.y) <= 1 &&
            panel.x < monitor.x + monitor.width && panel.x + panel.width > monitor.x)
            top = panel.y + panel.height;
        this._centerX = monitor.x + monitor.width / 2;
        this.y = top + this._settings.get_int('top-margin');
        this._reposition();
    }

    _xFor(width) {
        return Math.round((this._centerX ?? 0) - width / 2);
    }

    _reposition() {
        const [w] = this._state ? this._size(this._state) : [this.width];
        this.x = this._xFor(w);
    }

    // Style is set once per state change, never per animation frame.
    _restyle(glow = true) {
        const [, h] = this._size(this._state ?? 'idle');
        const radius = Math.min(h / 2, this._px(26));
        let shadow = '';
        const playing = this._mpris.active?.status === 'Playing';
        if (glow && this._state === 'done')
            shadow = `box-shadow: 0 0 ${this._px(22)}px 2px ${rgba(DONE_COLORS[this._done?.color] ?? DONE_COLORS.orange, 0.55)};`;
        else if (glow && this._state === 'call')
            shadow = `box-shadow: 0 0 ${this._px(22)}px 2px ${rgba([52, 199, 89], 0.5)};`;
        else if (glow && this._state?.startsWith('media') && playing && this._settings.get_boolean('glow'))
            shadow = `box-shadow: 0 2px ${this._px(18)}px 0 ${rgba(this._accent, 0.32)};`;
        this.style = `font-size: ${(13 * this._scale).toFixed(2)}px; border-radius: ${radius}px; ${shadow}`;
        this._ringRadius = radius;
        this._syncRing();
        if (this._aura) {
            this._aura.radius = radius;
            this._aura.color = this._accent;
            this._aura.scale = this._scale;
            this._aura.setMargin(this._px(14));
        }
    }

    // The cover-coloured edge; a new colour fades out and back in.
    _syncRing() {
        if (!this._ring)
            return;
        const show = this._settings.get_boolean('art-tint') && this._state?.startsWith('media') &&
            this._mpris.active?.status === 'Playing';
        const style = `border-radius: ${this._ringRadius ?? 0}px; border: ${Math.max(1, this._px(1.5))}px solid ${rgba(this._accent, 0.75)};`;
        if (!show) {
            if (!this._ringShown && style === this._ringStyle)
                return;
            this._ringShown = false;
            this._ringStyle = style;
            this._ring.ease({opacity: 0, duration: this._ms(250), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._ring.style = style;
            this._ringColor = String(this._accent);
            return;
        }
        const color = String(this._accent);
        if (style === this._ringStyle && this._ringShown)
            return;
        this._ringStyle = style;
        this._ringShown = true;
        if (color === this._ringColor || this._ring.opacity === 0) {
            this._ring.style = style;
            this._ringColor = color;
            this._ring.ease({opacity: 255, duration: this._ms(400), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        this._ringColor = color;
        this._ring.ease({
            opacity: 0,
            duration: this._ms(300),
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                this._ring.style = style;
                this._ring.ease({opacity: 255, duration: this._ms(500), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            },
        });
    }

    // ---- ghost -------------------------------------------------------------

    // While music plays the pill fades away from the pointer and lets clicks
    // through. Holding the pointer still on it (or holding Super) brings it
    // back to be used.
    _ghostable() {
        return this._state === 'media' && this._settings.get_boolean('ghost-mode') &&
            !this._ghostSolid && !this._suspended && !this._bannerShown;
    }

    _startGhost() {
        if (this._ghost)
            return;
        this._ghost = {still: 0, x: -1, y: -1, busy: false};
        this._clearTimeout('expand');
        // Clicking through means the window below is being used: stay out of the way.
        this._ghostCapture = global.stage.connect('captured-event', (_s, event) => {
            const type = event.type();
            if (this._ghost && (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN))
                this._ghost.busy = true;
            return Clutter.EVENT_PROPAGATE;
        });
        this._updateVisibility();
        this._setTimeout('ghost', GHOST_POLL, () => this._pollGhost());
    }

    _pollGhost() {
        const g = this._ghost;
        if (!g)
            return GLib.SOURCE_REMOVE;
        const [x, y, mods] = global.get_pointer();
        const [ax, ay] = this.get_transformed_position();
        const inside = x >= ax && y >= ay && x < ax + this.width && y < ay + this.height;
        if (!inside || this._state !== 'media') {
            this._endGhost(false);
            return GLib.SOURCE_REMOVE;
        }
        if (mods & (Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK)) {
            this._endGhost(true);
            return GLib.SOURCE_REMOVE;
        }
        const moved = Math.abs(x - g.x) > 3 || Math.abs(y - g.y) > 3;
        g.x = x;
        g.y = y;
        const still = moved || g.busy ? 0 : g.still + GHOST_POLL;
        if (still >= GHOST_DWELL) {
            this._endGhost(true);
            return GLib.SOURCE_REMOVE;
        }
        if (still !== g.still) {
            // Fills back in while the pointer rests: the dwell's progress.
            this.remove_transition('opacity');
            this.opacity = Math.round(GHOST_OPACITY + (255 - GHOST_OPACITY) * still / GHOST_DWELL);
        } else if (still === 0 && this.opacity !== GHOST_OPACITY) {
            this.ease({opacity: GHOST_OPACITY, duration: this._ms(120)});
        }
        g.still = still;
        return GLib.SOURCE_CONTINUE;
    }

    _endGhost(solid) {
        if (!this._ghost)
            return;
        this._ghost = null;
        this._clearTimeout('ghost');
        global.stage.disconnect(this._ghostCapture);
        this._ghostSolid = solid;
        this._updateVisibility();
        if (solid)
            this.sync_hover();
    }

    // ---- media -------------------------------------------------------------

    _onMediaChanged() {
        const p = this._mpris.active;
        const url = p?.artUrl ?? '';
        if (url !== this._artRequest) {
            this._artRequest = url;
            this._art.load(url).then(res => {
                if (this._artRequest !== url)
                    return;
                this._artPath = res?.path ?? null;
                this._accent = res?.color ?? DEFAULT_ACCENT;
                this._syncMedia();
                this._restyle();
            }).catch(e => console.error(`linux-island: ${e.message}`));
        }

        // New song while collapsed: peek at it for a moment.
        const key = p ? `${p.busName}|${p.title}|${p.artist}` : null;
        const changed = this._trackKey !== null && key !== null && key !== this._trackKey;
        this._trackKey = key;
        if (changed && p.status === 'Playing' && this._state === 'media' &&
            this._settings.get_boolean('peek-on-track-change') && !this.hover) {
            this._expanded = true;
            this._restartTimeout('collapse', this._ms(PEEK_TIME), () => this._collapse());
        }

        if (!this._hasMedia())
            this._expanded = this._expanded && this._toolsOpen;
        if (changed && this._state === 'queue')
            this._syncQueue();
        this._update();
        this._syncMedia();
        this._restyle();
        this._updateTickers();
    }

    _appIcon(p) {
        if (p?.desktopEntry) {
            const app = Shell.AppSystem.get_default().lookup_app(`${p.desktopEntry}.desktop`);
            if (app)
                return app.get_icon();
        }
        return new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
    }

    _syncMedia() {
        const p = this._mpris.active;
        if (!p)
            return;
        const icon = this._appIcon(p);
        this._miniCover.setArt(this._artPath, icon);
        this._cover.setArt(this._artPath, icon);
        this._miniTitle.text = p.artist ? `${p.title}  ·  ${p.artist}` : p.title;
        this._title.text = p.title;
        this._artist.text = p.artist || p.album || '';
        this._artist.visible = this._artist.text !== '';

        const count = this._mpris.players.length;
        this._sourceIcon.gicon = icon;
        this._sourceLabel.text = (p.identity || p.busName.replace('org.mpris.MediaPlayer2.', '')) +
            (count > 1 ? `   ⇄ ${count}` : '');

        const queueable = p.hasTrackList || p.hasPlaylists;
        this._queueBtn.visible = queueable;
        this._queueSpacer.visible = queueable;

        const playing = p.status === 'Playing';
        this._playBtn.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prevBtn.reactive = p.canPrev;
        this._prevBtn.opacity = p.canPrev ? 255 : 90;
        this._nextBtn.reactive = p.canNext;
        this._nextBtn.opacity = p.canNext ? 255 : 90;
        this._miniEq.setColor(this._accent);
        this._bigEq.setColor(this._accent);
        this._progress.setColor(this._accent);
        this._osdBar.setColor(this._accent);
        this._miniTitle.opacity = playing ? 255 : 150;
        this._syncProgress();
        this._updateTickers();
    }

    _syncProgress() {
        const p = this._mpris.active;
        if (!p)
            return;
        const known = p.length > 0;
        this._progress.fraction = known ? p.position / p.length : 0;
        this._progress.reactive = p.canSeek;
        this._posLabel.text = formatUs(p.position);
        this._lenLabel.text = known ? formatUs(p.length) : '';
        this._posLabel.visible = this._lenLabel.visible = known;
        this._progress.opacity = known ? 255 : 60;
    }

    // ---- timer & clock -----------------------------------------------------

    _onTimerChanged() {
        this._syncTimerRows();
        this._update();
    }

    _syncTimerRows() {
        const running = this._timer.running;
        this._presetRow.visible = !running;
        this._timerRow.visible = running;
        this._timerPauseBtn.child.icon_name = this._timer.paused
            ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        this._syncTimer();
    }

    _syncTimer() {
        const pomodoro = this._x.pomodoro;
        let text = this._timer.running ? formatTime(this._timer.remaining) : '';
        if (text && pomodoro.active)
            text = `🍅 ${pomodoro.phase === 'focus' ? 'Focus' : 'Break'}  ${text}`;
        this._timerRowLabel.text = text;
        this._syncLive();
    }

    _onTimerDone() {
        if (this._x.pomodoro.active)
            return; // the pomodoro announces its own phase change
        this._showDone({iconName: 'alarm-symbolic', title: "Time's up", subtitle: '', color: 'orange',
            sound: 'alarm-clock-elapsed', timeout: 20000});
    }

    // A big, glowing announcement that stays until clicked or @timeout.
    _showDone({iconName, title, subtitle, color, sound, repeat = false, timeout = 20000}) {
        this._done = {color};
        this._doneIcon.icon_name = iconName;
        this._doneIcon.style_class = `li-live-${color}`;
        this._doneTitle.text = title;
        this._doneSub.text = subtitle ?? '';
        this._doneSub.visible = !!subtitle;
        const play = () => global.display.get_sound_player().play_from_theme(sound, title, null);
        play();
        if (repeat) {
            this._clearTimeout('done-sound');
            this._setTimeout('done-sound', 4000, () => {
                play();
                return GLib.SOURCE_CONTINUE;
            });
        }
        this._restartTimeout('done', timeout, () => this._dismissDone());
        this._update();
        this._restyle();
    }

    _dismissDone() {
        this._clearTimeout('done');
        this._clearTimeout('done-sound');
        this._done = null;
        this._update();
    }

    _syncClock() {
        if (!this._clockLabel)
            return;
        const now = GLib.DateTime.new_now_local();
        this._clockLabel.text = now.format('%H:%M');
        this._dateLabel.text = now.format('%a %-d %b');
    }

    // ---- system events -----------------------------------------------------

    _showOsd({icon, label: text, level, maxLevel}) {
        this._osd = true;
        this._osdIcon.gicon = icon;
        const hasLevel = level !== null && level !== undefined;
        // GNOME passes level as volume/norm (can be >1 with overamplification)
        // and maxLevel as amplifiedMax/norm. The bar fills against the real
        // ceiling; the number matches GNOME/pactl (100% = normal max).
        const max = maxLevel > 0 ? maxLevel : 1;
        this._osdBar.visible = hasLevel;
        this._osdValue.visible = hasLevel;
        this._osdLabel.visible = !hasLevel || !!text;
        this._osdLabel.x_expand = !hasLevel;
        this._osdLabel.text = text ?? '';
        if (hasLevel) {
            this._osdBar.fraction = Math.min(1, level / max);
            this._osdValue.text = `${Math.round(level * 100)}`;
        }
        this._restartTimeout('osd', OSD_TIME, () => {
            this._osd = null;
            this._update();
        });
        this._update();
    }

    _showEvent({iconName, gicon, title, value, valueClass = '', iconClass = '', duration = EVENT_TIME, onClick = null}) {
        this._event = {onClick};
        if (gicon)
            this._eventIcon.gicon = gicon;
        else
            this._eventIcon.icon_name = iconName;
        this._eventIcon.style_class = iconClass;
        this._eventLabel.text = title ?? '';
        this._eventValue.text = value ?? '';
        this._eventValue.style_class = `li-event-value ${valueClass}`;
        this._restartTimeout('event', duration, () => {
            this._event = null;
            this._update();
        });
        this._update();
    }

    // ---- notifications -----------------------------------------------------

    _enqueue(n) {
        const kind = phoneKind(n);
        if (kind && !this._settings.get_boolean('show-phone'))
            return;
        // Mirrored app noise (YouTube, Reddit…) steals the island from media;
        // keep calls, SMS and repliable messages only.
        if (isGenericPhoneMirror(n))
            return;
        // The same call already came in over Bluetooth, with Answer.
        if ((kind === 'call' || kind === 'ongoing') && (this._x.btCalls.ringing || this._x.btCalls.live))
            return;
        // An answered call becomes a live activity, not a banner.
        if (kind === 'ongoing') {
            this._clearTimeout('call-end');
            this._call = {n, name: stripMarkup(callInfo(n).name), start: this._call?.start ?? GLib.get_monotonic_time()};
            n.connectObject('destroy', (_n, reason) => {
                // Phones repost the in-call notification every few seconds.
                const end = () => {
                    if (this._call?.n !== n)
                        return;
                    this._call = null;
                    this._syncLive();
                    this._update();
                };
                if (reason === MessageTray.NotificationDestroyedReason.REPLACED)
                    this._restartTimeout('call-end', 2000, end);
                else
                    end();
            }, this);
            this._queue.filter(q => phoneKind(q) === 'call').forEach(q => this._dropNotification(q));
            if (phoneKind(this._current) === 'call')
                this._nextNotification();
            this._syncLive();
            this._update();
            return;
        }
        // A reposted ringing notification takes the old one's place.
        if (kind === 'call' && phoneKind(this._current) === 'call' && this._current !== n) {
            this._clearTimeout('replaced');
            this._current.disconnectObject(this);
            this._current = n;
            this._watchDestroy(n);
            this._syncNotification();
            this._update();
            return;
        }
        // A ringing phone jumps the queue; what was showing comes back after.
        if (kind === 'call' && this._current && this._current !== n && !this._queue.includes(n)) {
            this._queue.unshift(this._current);
            this._current = null;
            this._watchDestroy(n);
            this._queue.unshift(n);
            this._nextNotification();
            return;
        }
        if (n === this._current) {
            this._syncNotification(); // updated: refresh and extend
            this._scheduleNotificationEnd();
            return;
        }
        if (this._queue.includes(n))
            return;
        this._watchDestroy(n);
        this._queue.push(n);
        if (!this._current)
            this._nextNotification();
        else
            this._syncNotificationCount();
    }

    _watchDestroy(n) {
        n.connectObject('destroy', (_n, reason) => {
            // A reposted phone notification (ringing) replaces this one
            // within moments; don't let the island flicker in between.
            if (reason === MessageTray.NotificationDestroyedReason.REPLACED && phoneKind(n) === 'call') {
                this._restartTimeout('replaced', 2000, () => this._dropNotification(n));
                return;
            }
            this._dropNotification(n);
        }, this);
    }

    _nextNotification() {
        if (this._replying)
            this._endReply();
        if (!this._queue.includes(this._current))
            this._current?.disconnectObject(this);
        this._current = this._queue.shift() ?? null;
        this._expanded = false;
        if (this._current) {
            this._syncNotification();
            this._scheduleNotificationEnd();
        } else {
            this._clearTimeout('notification');
        }
        this._update();
    }

    _syncNotification() {
        const n = this._current;
        if (!n)
            return;
        const app = n.source?.title ?? '';
        const title = stripMarkup(n.title);
        const body = notificationText(n);
        const icon = n.gicon ?? n.source?.icon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'});

        this._notifApp.text = app;
        this._notifTitle.text = title;
        this._notifBody.text = body;
        this._notifBody.visible = body !== '';
        this._notifIcon.gicon = icon;

        this._bigNotifApp.text = `${app}  ·  ${timeAgo(n.datetime)}`;
        this._bigNotifTitle.text = title;
        this._bigNotifBody.text = body;
        this._bigNotifIcon.gicon = icon;

        if (phoneKind(n) === 'call') {
            const info = callInfo(n);
            this._callName.text = stripMarkup(info.name) || title || app;
            this._callSub.text = 'Incoming call';
            this._callIcon.gicon = n.gicon ?? new Gio.ThemedIcon({name: 'call-start-symbolic'});
            this._showCallButtons(false);
        }

        this._actionRow.destroy_all_children();
        const canReply = canReplyViaPhone(n) || this._reply.canReply(n);
        console.log(`linux-island: notification from app=${sourceApp(n.source)?.get_id() ?? '-'} title=${app} reply=${canReply} actions=${n.actions.map(a => a.label).join('|')}${phoneKind(n) ? ` phone=${phoneKind(n)} id=${idShape(n)}` : ''}`);
        if (canReply)
            this._actionRow.add_child(this._textButton('Reply', 'li-chip li-chip-accent', () => this._startReply()));
        // The app's own "Reply" just opens the window; ours replaces it.
        const actions = n.actions.filter(a => !canReply || !/^(reply|پاسخ)/i.test(a.label.trim()));
        for (const action of actions.slice(0, 3)) {
            this._actionRow.add_child(this._textButton(action.label, 'li-chip', () => {
                const current = this._current;
                this._nextNotification();
                if (current)
                    action.activate();
            }));
        }
        this._actionRow.add_child(new St.Widget({x_expand: true}));
        this._actionRow.add_child(this._textButton('Open', 'li-chip', () => this._activateCurrent()));
        this._actionRow.add_child(this._iconButton('window-close-symbolic', 'li-small-btn', 14, () => this._nextNotification()));
        this._replyEntry.hint_text = `Reply to ${title || app}…`;
        this._syncNotificationCount();
    }

    _syncNotificationCount() {
        this._notifCount.text = this._queue.length > 0 ? `+${this._queue.length}` : '';
    }

    _scheduleNotificationEnd() {
        // A ringing call stays until it stops ringing or is dismissed.
        if (phoneKind(this._current) === 'call') {
            this._clearTimeout('notification');
            return;
        }
        const secs = this._settings.get_int('notification-duration');
        this._restartTimeout('notification', secs * 1000, () => {
            if (this.hover || this._replying)
                this._scheduleNotificationEnd();
            else
                this._nextNotification();
        });
    }

    _dropNotification(n) {
        n.disconnectObject(this);
        if (n === this._current) {
            this._current = null;
            this._nextNotification();
        } else {
            this._queue = this._queue.filter(q => q !== n);
            this._syncNotificationCount();
        }
    }

    _activateCurrent() {
        const n = this._current;
        this._nextNotification();
        if (n) {
            n.activate();
            Main.overview.hide();
        }
    }

    _startReply() {
        console.log(`linux-island: reply: open box (current=${!!this._current}, replying=${this._replying})`);
        if (!this._current || this._replying)
            return;
        this._replying = true;
        this._actionRow.hide();
        this._replyRow.show();
        this._replyEntry.text = '';
        this._update();
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._replyEntry.grab_key_focus();
    }

    async _sendReply() {
        const text = this._replyEntry.text.trim();
        const n = this._current;
        console.log(`linux-island: reply: send pressed (chars=${text.length}, notification=${!!n})`);
        if (!text || !n)
            return;
        // Keep the notification alive while its default action is used.
        n.disconnectObject(this);
        this._endReply();
        this._nextNotification();
        if (canReplyViaPhone(n)) {
            const sent = replyViaPhone(n, text);
            console.log(`linux-island: reply: via phone (${sent ? 'sent' : 'failed'})`);
            this._showOsd({
                icon: new Gio.ThemedIcon({name: sent ? 'phone-symbolic' : 'dialog-warning-symbolic'}),
                label: sent ? 'Sent from your phone' : 'Could not reach your phone',
                level: null,
            });
            return;
        }
        let result;
        this._x.clipboard.muted = true; // the reply goes through the clipboard
        try {
            result = await this._reply.send(n, text);
        } catch (e) {
            console.error(`linux-island: reply failed: ${e.message}`);
            result = 'copied';
        }
        this._restartTimeout('clipboard-unmute', 800, () => (this._x.clipboard.muted = false));
        this._showOsd({
            icon: new Gio.ThemedIcon({name: result === 'sent' ? 'mail-send-symbolic' : 'edit-paste-symbolic'}),
            label: result === 'sent' ? 'Reply sent' : 'Reply copied – paste it with Ctrl+V',
            level: null,
        });
    }

    _endReply() {
        if (!this._replying)
            return;
        this._replying = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        // Give the keyboard back to the app windows.
        if (this._replyEntry.clutter_text.has_key_focus())
            global.stage.set_key_focus(null);
        this._replyRow.hide();
        this._actionRow.show();
        this._scheduleNotificationEnd();
        this._update();
    }

    // ---- queue & playlists -------------------------------------------------

    _openQueue() {
        const p = this._mpris.active;
        if (!p)
            return;
        this._queueOpen = true;
        this._queueTab = p.hasTrackList ? 'queue' : 'playlists';
        this._update();
        this._syncQueue();
    }

    _setQueueTab(tab) {
        this._queueTab = tab;
        this._syncQueue();
    }

    async _syncQueue() {
        const p = this._mpris.active;
        if (!p || !this._queueOpen)
            return;
        const tab = this._queueTab;
        this._queueTabs.visible = p.hasTrackList && p.hasPlaylists;
        this._queueTabQueue.style_class = `li-btn li-chip${tab === 'queue' ? ' li-chip-on' : ''}`;
        this._queueTabLists.style_class = `li-btn li-chip${tab === 'playlists' ? ' li-chip-on' : ''}`;
        this._queueTitle.text = tab === 'queue' ? 'Up next' : 'Playlists';

        let items = [];
        try {
            items = tab === 'queue'
                ? (await p.getQueue()).map(t => ({...t, onClick: () => p.goTo(t.id)}))
                : (await p.getPlaylists()).map(l => ({title: l.name, current: l.active, onClick: () => p.activatePlaylist(l.id)}));
        } catch (e) {
            console.debug(`linux-island: queue: ${e.message}`);
        }
        if (this._queueTab !== tab || this._mpris.active !== p)
            return;

        this._queueBox.destroy_all_children();
        this._queueEmpty.text = tab === 'queue' ? 'The queue is empty' : 'No playlists';
        this._queueEmpty.visible = items.length === 0;
        this._queueScroll.visible = items.length > 0;
        let currentRow = null;
        items.forEach((item, i) => {
            const row = new St.BoxLayout({style_class: 'li-list-row', x_expand: true});
            const marker = item.current
                ? new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: this._px(14), style: `color: ${rgba(this._accent, 1)};`})
                : label(`${i + 1}`, 'li-queue-index');
            const markerBin = new St.Bin({child: marker, width: this._px(24), y_align: Clutter.ActorAlign.CENTER});
            row.add_child(markerBin);
            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const title = label(item.title || '—', 'li-list-title');
            if (item.current)
                title.style = `color: ${rgba(this._accent, 1)};`;
            text.add_child(title);
            if (item.artist)
                text.add_child(label(item.artist, 'li-list-body'));
            row.add_child(text);
            const button = new St.Button({style_class: 'li-list-btn', child: row, x_expand: true});
            button.connect('clicked', () => {
                item.onClick();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._syncQueue();
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._queueBox.add_child(button);
            if (item.current)
                currentRow = button;
        });
        // Scroll the playing track into view.
        if (currentRow) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                const adj = this._queueScroll.vadjustment;
                const box = currentRow.get_allocation_box();
                adj.value = Math.max(0, box.y1 - adj.page_size / 3);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // ---- notification list -------------------------------------------------

    _onHistoryChanged() {
        if (!this._unseenDot)
            return;
        const unseen = this._notifications.unseenCount;
        this._unseenDot.visible = unseen > 0;
        this._bellCounts.forEach(l => {
            l.text = unseen > 0 ? `${unseen}` : '';
            l.visible = unseen > 0;
        });
        if (this._state === 'list')
            this._syncList();
    }

    _openList() {
        this._listOpen = true;
        this._toolsOpen = false;
        this._expanded = false;
        this._notifications.markAllSeen();
        this._onHistoryChanged();
        this._update();
        if (!this.hover)
            this._restartTimeout('collapse', AUTO_COLLAPSE * 2, () => this._collapse());
    }

    _syncList() {
        this._listBox.destroy_all_children();
        const history = this._notifications.history.slice(0, 40);
        this._listEmpty.visible = history.length === 0;
        this._listScroll.visible = history.length > 0;
        this._listClear.visible = history.length > 0;
        for (const n of history) {
            const row = new St.BoxLayout({style_class: 'li-list-row', x_expand: true});
            row.add_child(new St.Icon({
                gicon: n.gicon ?? n.source?.icon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'}),
                icon_size: this._px(28),
                style_class: 'li-notif-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const head = new St.BoxLayout();
            head.add_child(label(stripMarkup(n.title) || n.source?.title || '', 'li-list-title', {x_expand: true}));
            head.add_child(label(timeAgo(n.datetime), 'li-notif-app'));
            text.add_child(head);
            const body = notificationText(n);
            if (body)
                text.add_child(label(body, 'li-list-body'));
            row.add_child(text);

            const button = new St.Button({style_class: 'li-list-btn', child: row, x_expand: true});
            button.connect('clicked', () => {
                this._collapse();
                n.activate();
                Main.overview.hide();
            });
            this._listBox.add_child(button);
        }
    }

    // ---- input -------------------------------------------------------------

    _onHover() {
        if (this.hover && this._ghostable()) {
            this._startGhost();
            return;
        }
        if (!this.hover && !this._ghost)
            this._ghostSolid = false;
        if (this.hover) {
            this._clearTimeout('collapse');
            const expandable = this._state === 'media' ||
                (this._state === 'notification' && this._current &&
                 (this._current.actions.length > 0 || this._reply.canReply(this._current) ||
                  notificationText(this._current).length > 50));
            if (expandable && this._settings.get_boolean('expand-on-hover'))
                this._restartTimeout('expand', this._ms(EXPAND_DELAY), () => this._expand());
        } else {
            this._clearTimeout('expand');
            if ((this._expanded || this._toolsOpen || this._listOpen || this._queueOpen) && !this._replying)
                this._restartTimeout('collapse', this._ms(COLLAPSE_DELAY), () => this._collapse());
        }
    }

    // While replying the island holds a grab: a click elsewhere cancels.
    _onPress(event) {
        if (!this._replying)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [ax, ay] = this.get_transformed_position();
        if (x < ax || y < ay || x > ax + this.width || y > ay + this.height) {
            this._endReply();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onClick(event) {
        const button = event.get_button();
        switch (this._state) {
        case 'done':
            this._dismissDone();
            break;
        case 'notification':
            if (button === Clutter.BUTTON_PRIMARY)
                this._activateCurrent();
            else
                this._nextNotification();
            break;
        case 'osd':
        case 'event': {
            const onClick = this._event?.onClick;
            this._osd = null;
            this._event = null;
            this._update();
            onClick?.();
            break;
        }
        case 'call':
            break;
        case 'idle':
        case 'live':
        case 'media':
            if (button === Clutter.BUTTON_SECONDARY)
                this._openList();
            else
                this._expand();
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        const dir = event.get_scroll_direction();
        let dx = 0, dy = 0;
        if (dir === Clutter.ScrollDirection.SMOOTH)
            [dx, dy] = event.get_scroll_delta();
        else if (dir === Clutter.ScrollDirection.UP)
            dy = -1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            dy = 1;
        else if (dir === Clutter.ScrollDirection.LEFT)
            dx = -1;
        else if (dir === Clutter.ScrollDirection.RIGHT)
            dx = 1;

        if (this._state === 'list' || this._state === 'queue')
            return Clutter.EVENT_PROPAGATE;

        // Sideways: previous / next track.
        if (Math.abs(dx) > Math.abs(dy) && this._state?.startsWith('media')) {
            this._scrollAcc += dx;
            if (Math.abs(this._scrollAcc) >= 1) {
                if (this._scrollAcc > 0)
                    this._mpris.active?.next();
                else
                    this._mpris.active?.previous();
                this._scrollAcc = 0;
            }
            return Clutter.EVENT_STOP;
        }
        // Up / down: system volume.
        if (dy !== 0 && this._settings.get_boolean('scroll-volume')) {
            this._scrollAcc += dy;
            const steps = Math.trunc(this._scrollAcc);
            if (steps !== 0) {
                this._scrollAcc -= steps;
                changeVolume(-steps);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _expand() {
        this._clearTimeout('expand');
        this._expanded = true;
        this._update();
        // Opened without the pointer (click on touch, shortcut): close again later.
        if (!this.hover)
            this._restartTimeout('collapse', AUTO_COLLAPSE, () => this._collapse());
    }

    _collapse() {
        if (this._replying)
            return;
        this._clearTimeout('collapse');
        this._expanded = false;
        this._toolsOpen = false;
        this._listOpen = false;
        this._queueOpen = false;
        this._update();
    }

    toggle() {
        if (this._replying) {
            this._endReply();
        } else if (this._state === 'notification' || this._state === 'notification-open') {
            this._nextNotification();
        } else if (this._state === 'done') {
            this._dismissDone();
        } else if (this._expanded || this._toolsOpen || this._listOpen || this._queueOpen) {
            this._collapse();
        } else {
            this._expand();
            if (!this.hover)
                this._restartTimeout('collapse', AUTO_COLLAPSE * 2, () => this._collapse());
        }
    }

    showList() {
        if (this._state === 'list')
            this._collapse();
        else
            this._openList();
    }

    _onDestroy() {
        if (this._ghost)
            global.stage.disconnect(this._ghostCapture);
        this._ghost = null;
        this._aura?.destroy();
        this._aura = null;
        this._privacy?.destroy();
        this._privacy = null;
        if (this._focusId)
            this._x.focus.disconnect(this._focusId);
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        for (const name of Object.keys(this._timeouts))
            this._clearTimeout(name);
        this._current?.disconnectObject(this);
        this._queue.forEach(n => n.disconnectObject(this));
        this._queue = [];
    }
});
