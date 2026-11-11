// The island itself: a black pill under the top bar that morphs between
// idle, now-playing, notification, timer and system views.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DEFAULT_ACCENT} from './art.js';
import {changeVolume} from './system.js';
import {Aura} from './visualizer.js';
import {formatTime, formatUs} from './timer.js';

// [width, height] of the island in each state, at scale 1.
const SIZES = {
    'idle': [120, 10],
    'idle-open': [360, 120],
    'timer': [170, 34],
    'media': [300, 36],
    'media-open': [420, 172],
    'notification': [420, 78],
    'notification-open': [420, 170],
    'list': [420, 320],
    'queue': [420, 320],
    'osd': [280, 38],
    'battery': [280, 38],
    'done': [280, 52],
};

// Milliseconds at animation speed 1.
const EXPAND_DELAY = 120;
const COLLAPSE_DELAY = 350;
const AUTO_COLLAPSE = 4000;
const GROW_TIME = 300;
const SHRINK_TIME = 230;
const PEEK_TIME = 2800;
const OSD_TIME = 1500;
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
        super({style_class: 'li-cover', width: size, height: size, y_align: Clutter.ActorAlign.CENTER});
        this._radius = radius;
        this._fallback = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: Math.round(size * 0.5)});
        this.setArt(null, null);
    }

    setArt(path, gicon) {
        if (path) {
            const uri = GLib.filename_to_uri(path, null).replace(/"/g, '%22');
            this.style = `border-radius: ${this._radius}px; background-image: url("${uri}"); background-size: cover;`;
            this.child = null;
        } else {
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
    constructor({settings, mpris, notifications, timer, art, battery, osd, spectrum, reply, openPrefs}) {
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
        this._aura = null;

        this._state = null;
        this._expanded = false;
        this._toolsOpen = false;
        this._listOpen = false;
        this._queueOpen = false;
        this._queueTab = 'queue';
        this._timerDone = false;
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
        this._build();

        this.connect('notify::hover', () => this._onHover());
        this.connect('button-press-event', (_a, event) => this._onPress(event));
        this.connect('button-release-event', (_a, event) => this._onClick(event));
        this.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.addChrome(this, {trackFullscreen: true});
        this._aura = new Aura(this, spectrum, this._px(22));
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
        battery.connectObject('event', (_b, ev) => this._showEvent(ev), this);
        osd.connectObject('osd', (_o, info) => this._showOsd(info), this);
        settings.connectObject('changed', (_s, key) => {
            if (key === 'scale')
                this._rebuild();
            this._relayout();
            this._update();
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
        this._buildBattery();
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
        this._dateLabel = label('', 'li-date', {x_expand: true, x_align: Clutter.ActorAlign.END});
        top.add_child(this._clockLabel);
        top.add_child(this._dateLabel);
        top.add_child(this._bellButton());
        top.add_child(this._iconButton('emblem-system-symbolic', 'li-small-btn', 14, () => {
            this._collapse();
            this._openPrefs();
        }));
        box.add_child(top);

        // Preset buttons when no timer runs, controls when one does.
        this._presetRow = new St.BoxLayout({style_class: 'li-row li-presets', x_expand: true});
        this._timerRow = new St.BoxLayout({style_class: 'li-row', x_expand: true});
        this._timerRowLabel = label('', 'li-timer-big', {x_expand: true});
        this._timerPauseBtn = this._iconButton('media-playback-pause-symbolic', 'li-round-btn', 16, () => {
            if (this._timer.paused)
                this._timer.resume();
            else
                this._timer.pause();
        });
        this._timerRow.add_child(this._icon('alarm-symbolic', 18, 'li-dim-icon'));
        this._timerRow.add_child(this._timerRowLabel);
        this._timerRow.add_child(this._timerPauseBtn);
        this._timerRow.add_child(this._iconButton('process-stop-symbolic', 'li-round-btn', 16, () => this._timer.stop()));
        box.add_child(this._presetRow);
        box.add_child(this._timerRow);
        this._rebuildPresets();
        this._settings.connectObject('changed::timer-presets', () => this._rebuildPresets(), this);

        this._addView('idle-open', box);
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

    _buildTimer() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact'});
        box.add_child(this._icon('alarm-symbolic', 15, 'li-accent-icon'));
        this._timerLabel = label('', 'li-timer-small', {x_expand: true, x_align: Clutter.ActorAlign.END});
        box.add_child(this._timerLabel);
        this._addView('timer', box);
    }

    _buildMedia() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact'});
        this._miniCover = new Cover(this._px(24), this._px(7));
        this._miniTitle = label('', 'li-mini-title', {x_expand: true});
        this._miniEq = new Equalizer(this._px(14), this._px(3));
        this._miniTimer = label('', 'li-timer-small');
        box.add_child(this._miniCover);
        box.add_child(this._miniTitle);
        box.add_child(this._miniTimer);
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

    _buildBattery() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact li-osd'});
        this._batteryIcon = new St.Icon({icon_size: this._px(18), y_align: Clutter.ActorAlign.CENTER});
        this._batteryLabel = label('', 'li-osd-label', {x_expand: true});
        this._batteryValue = label('', 'li-battery-value');
        box.add_child(this._batteryIcon);
        box.add_child(this._batteryLabel);
        box.add_child(this._batteryValue);
        this._addView('battery', box);
    }

    _buildDone() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact li-done'});
        box.add_child(this._icon('alarm-symbolic', 22, 'li-accent-icon'));
        box.add_child(label("Time's up", 'li-done-label', {x_expand: true}));
        box.add_child(label('click to dismiss', 'li-notif-app'));
        this._addView('done', box);
    }

    // ---- state machine -----------------------------------------------------

    _hasMedia() {
        return this._settings.get_boolean('show-media') && this._mpris.active !== null;
    }

    _computeState() {
        if (this._timerDone)
            return 'done';
        if (this._current)
            return this._expanded || this._replying ? 'notification-open' : 'notification';
        if (this._osd)
            return 'osd';
        if (this._event)
            return 'battery';
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
        if (this._timer.running)
            return 'timer';
        return 'idle';
    }

    _update() {
        const state = this._computeState();
        this._syncState(state);
        if (state === this._state)
            return;
        const old = this._state;
        this._state = state;

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
        if (state === 'idle-open')
            this._syncClock();
        if (state === 'timer' || state === 'idle-open' || state === 'media')
            this._syncTimer();
        if (state === 'media' || state === 'media-open')
            this._syncMedia();
        if (state === 'list')
            this._syncList();
    }

    _updateVisibility() {
        const hidden = this._suspended || this._bannerShown ||
            (this._state === 'idle' && this._settings.get_boolean('hide-when-idle'));
        this.reactive = !hidden;
        this._notifications.blocked = this._suspended;
        this.ease({opacity: hidden ? 0 : 255, duration: this._ms(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (this._views)
            this._updateTickers();
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
        const mode = this._settings.get_string('visualizer');
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
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._clearTimeout('clock');
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
        const monitor = Main.layoutManager.primaryMonitor;
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
            shadow = `box-shadow: 0 0 ${this._px(22)}px 2px ${rgba([255, 159, 67], 0.55)};`;
        else if (glow && this._state?.startsWith('media') && playing && this._settings.get_boolean('glow'))
            shadow = `box-shadow: 0 2px ${this._px(18)}px 0 ${rgba(this._accent, 0.32)};`;
        this.style = `font-size: ${(13 * this._scale).toFixed(2)}px; border-radius: ${radius}px; ${shadow}`;
        if (this._aura) {
            this._aura.radius = radius;
            this._aura.color = this._accent;
            this._aura.scale = this._scale;
            this._aura.setMargin(this._px(22));
        }
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
        const text = this._timer.running ? formatTime(this._timer.remaining) : '';
        this._timerLabel.text = text;
        this._timerRowLabel.text = text;
        this._miniTimer.text = text;
        this._miniTimer.visible = text !== '';
        this._miniEq.visible = text === '';
    }

    _onTimerDone() {
        this._timerDone = true;
        global.display.get_sound_player().play_from_theme('alarm-clock-elapsed', "Time's up", null);
        this._restartTimeout('done', 20000, () => this._dismissDone());
        this._update();
    }

    _dismissDone() {
        this._clearTimeout('done');
        this._timerDone = false;
        this._update();
    }

    _syncClock() {
        const now = GLib.DateTime.new_now_local();
        this._clockLabel.text = now.format('%H:%M');
        this._dateLabel.text = now.format('%a %-d %b');
    }

    // ---- system events -----------------------------------------------------

    _showOsd({icon, label: text, level, maxLevel}) {
        this._osd = true;
        this._osdIcon.gicon = icon;
        const hasLevel = level !== null && level !== undefined;
        const max = maxLevel > 0 ? maxLevel : 1;
        this._osdBar.visible = hasLevel;
        this._osdValue.visible = hasLevel;
        this._osdLabel.visible = !hasLevel || !!text;
        this._osdLabel.x_expand = !hasLevel;
        this._osdLabel.text = text ?? '';
        if (hasLevel) {
            this._osdBar.fraction = level / max;
            this._osdValue.text = `${Math.round(level / max * 100)}`;
        }
        this._restartTimeout('osd', OSD_TIME, () => {
            this._osd = null;
            this._update();
        });
        this._update();
    }

    _showEvent(ev) {
        if (!this._settings.get_boolean('show-battery'))
            return;
        this._event = ev;
        this._batteryIcon.icon_name = ev.iconName;
        this._batteryLabel.text = BATTERY_TEXT[ev.kind] ?? '';
        this._batteryValue.text = `${ev.percent}%`;
        const color = ev.kind === 'low' ? 'li-battery-low' : ev.kind === 'unplugged' ? '' : 'li-battery-ok';
        this._batteryValue.style_class = `li-battery-value ${color}`;
        this._batteryIcon.style_class = color;
        this._restartTimeout('event', EVENT_TIME, () => {
            this._event = null;
            this._update();
        });
        this._update();
    }

    // ---- notifications -----------------------------------------------------

    _enqueue(n) {
        if (n === this._current) {
            this._syncNotification(); // updated: refresh and extend
            this._scheduleNotificationEnd();
            return;
        }
        if (this._queue.includes(n))
            return;
        n.connectObject('destroy', () => this._dropNotification(n), this);
        this._queue.push(n);
        if (!this._current)
            this._nextNotification();
        else
            this._syncNotificationCount();
    }

    _nextNotification() {
        if (this._replying)
            this._endReply();
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

        this._actionRow.destroy_all_children();
        const canReply = this._reply.canReply(n);
        console.log(`linux-island: notification from app=${n.source?.app?.get_id() ?? '-'} title=${app} reply=${canReply} actions=${n.actions.map(a => a.label).join('|')}`);
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
        let result;
        try {
            result = await this._reply.send(n, text);
        } catch (e) {
            console.error(`linux-island: reply failed: ${e.message}`);
            result = 'copied';
        }
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
        case 'battery':
            this._osd = null;
            this._event = null;
            this._update();
            break;
        case 'idle':
        case 'timer':
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
        this._aura?.destroy();
        this._aura = null;
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
