// The island itself: a black pill under the top bar that morphs between
// idle, now-playing, notification and timer views.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DEFAULT_ACCENT} from './art.js';
import {formatTime, formatUs} from './timer.js';

// [width, height] of the island in each state.
const SIZES = {
    'idle': [120, 10],
    'idle-open': [360, 120],
    'timer': [170, 34],
    'media': [300, 36],
    'media-open': [420, 172],
    'notification': [420, 78],
    'done': [280, 52],
};

const EXPAND_DELAY = 220;
const COLLAPSE_DELAY = 550;
const AUTO_COLLAPSE = 4000;

function label(text, styleClass, params = {}) {
    const l = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function iconButton(iconName, styleClass, iconSize, callback) {
    const button = new St.Button({
        style_class: `li-btn ${styleClass}`,
        child: new St.Icon({icon_name: iconName, icon_size: iconSize}),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => callback());
    return button;
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

// Rounded cover art; falls back to the player's icon.
const Cover = GObject.registerClass(
class Cover extends St.Bin {
    constructor(size, radius) {
        super({style_class: 'li-cover', width: size, height: size, y_align: Clutter.ActorAlign.CENTER});
        this._radius = radius;
        this._fallback = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: Math.round(size * 0.5)});
        this.set({x_align: Clutter.ActorAlign.START});
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
    constructor(maxHeight) {
        super({style_class: 'li-eq', y_align: Clutter.ActorAlign.CENTER});
        this._max = maxHeight;
        this._bars = [0, 1, 2, 3].map(() => {
            const bar = new St.Widget({style_class: 'li-eq-bar', height: 3, y_align: Clutter.ActorAlign.CENTER});
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
                height: 3 + Math.random() * (this._max - 3),
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
        this._bars.forEach(b => b.ease({height: 3, duration: 200}));
    }
});

// Thin progress bar; click or drag to seek.
const Progress = GObject.registerClass({
    Signals: {'seek': {param_types: [GObject.TYPE_DOUBLE]}},
}, class Progress extends St.Widget {
    constructor() {
        super({style_class: 'li-progress', reactive: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
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
    constructor({settings, mpris, notifications, timer, art, openPrefs}) {
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

        this._state = null;
        this._expanded = false;
        this._toolsOpen = false;
        this._timerDone = false;
        this._queue = [];
        this._current = null;
        this._accent = DEFAULT_ACCENT;
        this._artPath = null;
        this._artRequest = null;
        this._timeouts = {};
        this._suspended = false;

        this._clip = new St.Widget({
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this.add_child(this._clip);

        this._views = {};
        this._buildIdle();
        this._buildIdleOpen();
        this._buildTimer();
        this._buildMedia();
        this._buildMediaOpen();
        this._buildNotification();
        this._buildDone();

        const [w, h] = SIZES.idle;
        this.set_size(w, h);

        this.connect('notify::height', () => this._restyle());
        this.connect('notify::hover', () => this._onHover());
        this.connect('button-release-event', (_a, event) => this._onClick(event));
        this.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.addChrome(this, {trackFullscreen: true});

        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);
        Main.layoutManager.panelBox.connectObject(
            'notify::allocation', () => this._relayout(),
            'notify::visible', () => this._relayout(), this);
        Main.panel.statusArea.dateMenu?.menu.connectObject('open-state-changed',
            (_m, open) => this._setSuspended(open), this);

        mpris.connectObject(
            'changed', () => this._onMediaChanged(),
            'position', () => this._syncProgress(), this);
        notifications.connectObject('notification', (_w, n) => this._enqueue(n), this);
        timer.connectObject(
            'changed', () => this._onTimerChanged(),
            'tick', () => this._syncTimer(),
            'done', () => this._onTimerDone(), this);
        settings.connectObject('changed', () => {
            this._relayout();
            this._update();
        }, this);

        this._relayout();
        this._onMediaChanged();
        this._onTimerChanged();
    }

    // ---- views -------------------------------------------------------------

    _addView(name, actor) {
        const [w, h] = SIZES[name];
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

    _buildIdle() {
        this._addView('idle', new St.Widget());
    }

    _buildIdleOpen() {
        const box = new St.BoxLayout({style_class: 'li-view li-idle-open', orientation: Clutter.Orientation.VERTICAL});

        const top = new St.BoxLayout({style_class: 'li-row'});
        this._clockLabel = label('', 'li-clock');
        this._dateLabel = label('', 'li-date', {x_expand: true, x_align: Clutter.ActorAlign.END});
        top.add_child(this._clockLabel);
        top.add_child(this._dateLabel);
        top.add_child(iconButton('emblem-system-symbolic', 'li-small-btn', 14, () => this._openPrefs()));
        box.add_child(top);

        // Preset buttons when no timer runs, controls when one does.
        this._presetRow = new St.BoxLayout({style_class: 'li-row li-presets', x_expand: true});
        this._timerRow = new St.BoxLayout({style_class: 'li-row', x_expand: true});
        this._timerRowLabel = label('', 'li-timer-big', {x_expand: true});
        this._timerPauseBtn = iconButton('media-playback-pause-symbolic', 'li-round-btn', 16, () => {
            if (this._timer.paused)
                this._timer.resume();
            else
                this._timer.pause();
        });
        this._timerRow.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: 18, style_class: 'li-dim-icon'}));
        this._timerRow.add_child(this._timerRowLabel);
        this._timerRow.add_child(this._timerPauseBtn);
        this._timerRow.add_child(iconButton('process-stop-symbolic', 'li-round-btn', 16, () => this._timer.stop()));
        box.add_child(this._presetRow);
        box.add_child(this._timerRow);
        this._rebuildPresets();
        this._settings.connectObject('changed::timer-presets', () => this._rebuildPresets(), this);

        this._addView('idle-open', box);
    }

    _rebuildPresets() {
        this._presetRow.destroy_all_children();
        this._presetRow.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: 18, style_class: 'li-dim-icon'}));
        for (const min of this._settings.get_value('timer-presets').deepUnpack()) {
            const b = new St.Button({label: min >= 60 ? `${min / 60}h` : `${min}m`, style_class: 'li-btn li-preset', x_expand: true});
            b.connect('clicked', () => {
                this._timer.start(min);
                this._collapse();
            });
            this._presetRow.add_child(b);
        }
    }

    _buildTimer() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact'});
        box.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: 15, style_class: 'li-accent-icon'}));
        this._timerLabel = label('', 'li-timer-small', {x_expand: true, x_align: Clutter.ActorAlign.END});
        box.add_child(this._timerLabel);
        this._addView('timer', box);
    }

    _buildMedia() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact'});
        this._miniCover = new Cover(24, 7);
        this._miniTitle = label('', 'li-mini-title', {x_expand: true});
        this._miniEq = new Equalizer(14);
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
        this._cover = new Cover(64, 14);
        const info = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'li-info'});
        this._title = label('', 'li-title');
        this._artist = label('', 'li-artist');
        this._sourceBtn = new St.Button({style_class: 'li-source', x_align: Clutter.ActorAlign.START});
        const sourceBox = new St.BoxLayout({style_class: 'li-source-box'});
        this._sourceIcon = new St.Icon({icon_size: 12});
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
        this._bigEq = new Equalizer(20);
        top.add_child(this._cover);
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
        const timerBtn = iconButton('alarm-symbolic', 'li-small-btn', 14, () => {
            this._toolsOpen = true;
            this._update();
        });
        const center = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.CENTER, style_class: 'li-ctrl-center'});
        this._prevBtn = iconButton('media-skip-backward-symbolic', 'li-ctrl', 20, () => this._mpris.active?.previous());
        this._playBtn = iconButton('media-playback-start-symbolic', 'li-ctrl li-play', 22, () => this._mpris.active?.playPause());
        this._nextBtn = iconButton('media-skip-forward-symbolic', 'li-ctrl', 20, () => this._mpris.active?.next());
        center.add_child(this._prevBtn);
        center.add_child(this._playBtn);
        center.add_child(this._nextBtn);
        ctrl.add_child(timerBtn);
        ctrl.add_child(center);
        ctrl.add_child(new St.Widget({width: 26})); // balances timerBtn
        box.add_child(ctrl);

        this._addView('media-open', box);
    }

    _buildNotification() {
        const box = new St.BoxLayout({style_class: 'li-view li-notification'});
        this._notifIcon = new St.Icon({icon_size: 38, style_class: 'li-notif-icon', y_align: Clutter.ActorAlign.CENTER});
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

    _buildDone() {
        const box = new St.BoxLayout({style_class: 'li-view li-compact li-done'});
        box.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: 22, style_class: 'li-accent-icon'}));
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
            return 'notification';
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

        const [w, h] = SIZES[state];
        const growing = !old || w * h >= SIZES[old][0] * SIZES[old][1];
        this.remove_transition('width');
        this.remove_transition('height');
        this.remove_transition('x');
        this.ease({
            x: this._xFor(w),
            width: w,
            height: h,
            duration: growing ? 420 : 320,
            mode: growing ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        for (const [name, view] of Object.entries(this._views)) {
            if (name === state) {
                view.show();
                view.remove_all_transitions();
                view.ease({opacity: 255, duration: 220, delay: old ? 90 : 0, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else if (view.visible) {
                view.remove_all_transitions();
                view.ease({
                    opacity: 0,
                    duration: 110,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
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
        this._restyle();
    }

    _updateVisibility() {
        const hidden = this._suspended ||
            (this._state === 'idle' && this._settings.get_boolean('hide-when-idle'));
        this.reactive = !hidden;
        this._notifications.blocked = this._suspended;
        this.ease({opacity: hidden ? 0 : 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
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
        if (this._state === 'media' && playing)
            this._miniEq.start();
        else
            this._miniEq.stop();
        if (this._state === 'media-open' && playing)
            this._bigEq.start();
        else
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
        const [w] = this._state ? SIZES[this._state] : [this.width];
        this.x = this._xFor(w);
    }

    _restyle() {
        const radius = Math.min(this.height / 2, 26);
        let glow = '';
        const playing = this._mpris.active?.status === 'Playing';
        if (this._state === 'done')
            glow = `box-shadow: 0 0 22px 2px ${rgba([255, 159, 67], 0.55)};`;
        else if ((this._state === 'media' || this._state === 'media-open') && playing)
            glow = `box-shadow: 0 2px 18px 0 ${rgba(this._accent, 0.32)};`;
        this.style = `border-radius: ${radius}px; ${glow}`;
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
        if (!this._hasMedia())
            this._expanded = this._expanded && this._toolsOpen;
        this._update();
        this._syncMedia();
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

        const playing = p.status === 'Playing';
        this._playBtn.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prevBtn.reactive = p.canPrev;
        this._prevBtn.opacity = p.canPrev ? 255 : 90;
        this._nextBtn.reactive = p.canNext;
        this._nextBtn.opacity = p.canNext ? 255 : 90;
        this._miniEq.setColor(this._accent);
        this._bigEq.setColor(this._accent);
        this._progress.setColor(this._accent);
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
        const running = this._timer.running;
        this._presetRow.visible = !running;
        this._timerRow.visible = running;
        this._timerPauseBtn.child.icon_name = this._timer.paused
            ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        this._syncTimer();
        this._update();
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

    // ---- notifications -----------------------------------------------------

    _enqueue(n) {
        if (n === this._current) {
            this._showNotification(); // updated: refresh and extend
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
        this._current = this._queue.shift() ?? null;
        if (this._current)
            this._showNotification();
        else
            this._clearTimeout('notification');
        this._update();
    }

    _showNotification() {
        const n = this._current;
        this._notifApp.text = n.source?.title ?? '';
        this._notifTitle.text = stripMarkup(n.title);
        this._notifBody.text = n.useBodyMarkup ? stripMarkup(n.body) : (n.body ?? '').replace(/\s+/g, ' ').trim();
        this._notifBody.visible = this._notifBody.text !== '';
        this._notifIcon.gicon = n.gicon ?? n.source?.icon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
        this._syncNotificationCount();
        this._scheduleNotificationEnd();
    }

    _syncNotificationCount() {
        this._notifCount.text = this._queue.length > 0 ? `+${this._queue.length}` : '';
    }

    _scheduleNotificationEnd() {
        const secs = this._settings.get_int('notification-duration');
        this._restartTimeout('notification', secs * 1000, () => {
            if (this.hover)
                this._scheduleNotificationEnd();
            else
                this._finishNotification();
        });
    }

    _finishNotification() {
        this._current?.disconnectObject(this);
        this._nextNotification();
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

    // ---- input -------------------------------------------------------------

    _onHover() {
        if (this.hover) {
            this._clearTimeout('collapse');
            if (this._state === 'media' && this._settings.get_boolean('expand-on-hover'))
                this._restartTimeout('expand', EXPAND_DELAY, () => this._expand());
        } else {
            this._clearTimeout('expand');
            if (this._expanded || this._toolsOpen)
                this._restartTimeout('collapse', COLLAPSE_DELAY, () => this._collapse());
        }
    }

    _onClick(event) {
        const button = event.get_button();
        switch (this._state) {
        case 'done':
            this._dismissDone();
            break;
        case 'notification':
            if (button === Clutter.BUTTON_PRIMARY && this._current) {
                const n = this._current;
                this._finishNotification();
                n.activate();
                Main.overview.hide();
            } else {
                this._finishNotification();
            }
            break;
        case 'idle':
        case 'timer':
        case 'media':
            this._expand();
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        if (!this._state?.startsWith('media'))
            return Clutter.EVENT_PROPAGATE;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.LEFT)
            this._mpris.active?.previous();
        else if (dir === Clutter.ScrollDirection.RIGHT)
            this._mpris.active?.next();
        return Clutter.EVENT_STOP;
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
        this._clearTimeout('collapse');
        this._expanded = false;
        this._toolsOpen = false;
        this._update();
    }

    toggle() {
        if (this._state === 'notification') {
            this._finishNotification();
        } else if (this._state === 'done') {
            this._dismissDone();
        } else if (this._expanded || this._toolsOpen) {
            this._collapse();
        } else {
            this._expand();
            if (!this.hover)
                this._restartTimeout('collapse', AUTO_COLLAPSE * 2, () => this._collapse());
        }
    }

    _onDestroy() {
        for (const name of Object.keys(this._timeouts))
            this._clearTimeout(name);
        this._current?.disconnectObject(this);
        this._queue.forEach(n => n.disconnectObject(this));
        this._queue = [];
    }
});
