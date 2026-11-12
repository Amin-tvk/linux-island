// Screen time: how long the computer is in use each day, and which apps
// have the focus during that time. Time only counts while someone is
// there: not while locked, and not after two idle minutes (unless the
// focused window is fullscreen, as with a video). Kept on this computer
// only, in ~/.local/share/linux-island/usage.json, for two weeks.

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const TICK_SECS = 5;
const IDLE_MS = 2 * 60 * 1000;
const SAVE_SECS = 60;
const KEEP_DAYS = 14;

function dayKey(date = GLib.DateTime.new_now_local()) {
    return date.format('%Y-%m-%d');
}

// Emits 'changed' about once a minute while time is counted.
export class ScreenTime extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'linux-island']);
        this._path = GLib.build_filenamev([this._dir, 'usage.json']);
        this._days = {};
        this._names = {};
        this._dirty = false;
        this._sinceSave = 0;
        this._last = GLib.get_monotonic_time();
        this._load();
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TICK_SECS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _load() {
        try {
            const [, bytes] = GLib.file_get_contents(this._path);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            this._days = data.days ?? {};
            this._names = data.names ?? {};
        } catch {
            // First run, or unreadable: start over.
        }
    }

    _save() {
        const keep = Object.keys(this._days).sort().slice(-KEEP_DAYS);
        this._days = Object.fromEntries(keep.map(k => [k, this._days[k]]));
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            GLib.file_set_contents(this._path, JSON.stringify({days: this._days, names: this._names}));
        } catch (e) {
            console.warn(`linux-island: could not save screen time: ${e.message}`);
        }
        this._dirty = false;
        this._sinceSave = 0;
    }

    _present() {
        if (Main.sessionMode.isLocked || Main.screenShield?.locked)
            return false;
        const idle = global.backend.get_core_idle_monitor().get_idletime();
        if (idle < IDLE_MS)
            return true;
        // Watching something: no input, but someone is there.
        return !!global.display.focus_window?.is_fullscreen();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        // Capped, so a suspend does not count as use.
        const secs = Math.min((now - this._last) / 1e6, TICK_SECS * 2);
        this._last = now;
        if (!this._settings.get_boolean('screen-time') || !this._present())
            return;
        const day = this._days[dayKey()] ??= {total: 0, apps: {}};
        day.total += secs;
        const app = Shell.WindowTracker.get_default().focus_app;
        if (app) {
            const id = app.get_id();
            day.apps[id] = (day.apps[id] ?? 0) + secs;
            this._names[id] = app.get_name();
        }
        this._dirty = true;
        this._sinceSave += secs;
        if (this._sinceSave >= SAVE_SECS) {
            this._save();
            this.emit('changed');
        }
    }

    // Seconds of use today.
    get todayTotal() {
        return this._days[dayKey()]?.total ?? 0;
    }

    // Apps used today, most used first: [{id, name, secs, app}].
    topApps(count = 5) {
        const apps = this._days[dayKey()]?.apps ?? {};
        const system = Shell.AppSystem.get_default();
        return Object.entries(apps)
            .sort((a, b) => b[1] - a[1])
            .slice(0, count)
            .map(([id, secs]) => {
                const app = system.lookup_app(id);
                return {id, secs, app, name: app?.get_name() ?? this._names[id] ?? id.replace(/\.desktop$/, '')};
            });
    }

    // The last seven days, oldest first: [{label, secs, today}].
    week() {
        const today = GLib.DateTime.new_now_local();
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const date = today.add_days(-i);
            days.push({label: date.format('%a').slice(0, 2), secs: this._days[dayKey(date)]?.total ?? 0, today: i === 0});
        }
        return days;
    }

    destroy() {
        GLib.source_remove(this._id);
        if (this._dirty)
            this._save();
        this.disconnectAll();
    }
}

// 3h 12m, 45m, <1m
export function formatDuration(secs) {
    const mins = Math.floor(secs / 60);
    if (mins < 1)
        return '<1m';
    const h = Math.floor(mins / 60);
    return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}
