// Countdown timer shown in the island.

import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

export class Timer extends EventEmitter {
    constructor() {
        super();
        this.total = 0; // ms
        this._end = 0;
        this._left = 0;
        this._tickId = 0;
    }

    get running() {
        return this._end > 0 || this._left > 0;
    }

    get paused() {
        return this._end === 0 && this._left > 0;
    }

    // Milliseconds left.
    get remaining() {
        if (this._end)
            return Math.max(0, this._end - GLib.get_monotonic_time() / 1000);
        return this._left;
    }

    start(minutes) {
        this.finished = false;
        this.total = minutes * 60000;
        this._left = 0;
        this._end = GLib.get_monotonic_time() / 1000 + this.total;
        this._schedule();
        this.emit('changed');
    }

    pause() {
        if (!this._end)
            return;
        this._left = this.remaining;
        this._end = 0;
        this._unschedule();
        this.emit('changed');
    }

    resume() {
        if (!this.paused)
            return;
        this._end = GLib.get_monotonic_time() / 1000 + this._left;
        this._left = 0;
        this._schedule();
        this.emit('changed');
    }

    stop() {
        this.finished = false;
        this._end = 0;
        this._left = 0;
        this._unschedule();
        this.emit('changed');
    }

    _schedule() {
        this._unschedule();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this.remaining <= 0) {
                this._tickId = 0;
                this._end = 0;
                this.finished = true;
                this.emit('changed');
                this.emit('done');
                return GLib.SOURCE_REMOVE;
            }
            this.emit('tick');
            return GLib.SOURCE_CONTINUE;
        });
    }

    _unschedule() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    destroy() {
        this._unschedule();
        this.disconnectAll();
    }
}

// Counts up; emits 'changed'.
export class Stopwatch extends EventEmitter {
    constructor() {
        super();
        this._start = 0;     // monotonic ms when running
        this._acc = 0;       // ms accumulated before the last start
    }

    get running() {
        return this._start > 0;
    }

    get active() {
        return this.running || this._acc > 0;
    }

    get elapsed() {
        return this._acc + (this._start ? GLib.get_monotonic_time() / 1000 - this._start : 0);
    }

    toggle() {
        if (this._start) {
            this._acc = this.elapsed;
            this._start = 0;
        } else {
            this._start = GLib.get_monotonic_time() / 1000;
        }
        this.emit('changed');
    }

    reset() {
        this._start = 0;
        this._acc = 0;
        this.emit('changed');
    }

    destroy() {
        this.disconnectAll();
    }
}

// Focus / break cycles on top of a Timer. Emits 'changed' and
// 'phase-done' {next: 'focus'|'break'|'long-break', minutes}.
export class Pomodoro extends EventEmitter {
    constructor(timer, settings) {
        super();
        this._timer = timer;
        this._settings = settings;
        this.phase = null;   // 'focus' | 'break' | 'long-break' | null
        this.round = 0;      // completed focus sessions
        timer.connectObject('done', () => this._onDone(), this);
        timer.connectObject('changed', () => {
            // A stop or a plain timer replaces the pomodoro.
            if (this.phase && !timer.running && !timer.finished && !this._switching) {
                this.phase = null;
                this.emit('changed');
            }
        }, this);
    }

    get active() {
        return this.phase !== null;
    }

    get rounds() {
        return this._settings.get_int('pomodoro-rounds');
    }

    _minutes(phase) {
        return this._settings.get_int(phase === 'focus' ? 'pomodoro-focus'
            : phase === 'break' ? 'pomodoro-break' : 'pomodoro-long-break');
    }

    start() {
        this.round = 0;
        this._enter('focus');
    }

    stop() {
        this.phase = null;
        this._timer.stop();
        this.emit('changed');
    }

    _enter(phase) {
        this._switching = true;
        this.phase = phase;
        this._timer.start(this._minutes(phase));
        this._switching = false;
        this.emit('changed');
    }

    _onDone() {
        if (!this.phase)
            return;
        let next;
        if (this.phase === 'focus') {
            this.round++;
            next = this.round % this.rounds === 0 ? 'long-break' : 'break';
        } else {
            next = 'focus';
        }
        this.emit('phase-done', {next, minutes: this._minutes(next)});
        this._enter(next);
    }

    destroy() {
        this._timer.disconnectObject(this);
        this.disconnectAll();
    }
}

// Daily alarms from the 'alarms' setting ("HH:MM"). Emits 'ring' {time}.
export class AlarmClock extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._rung = new Set();
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get alarms() {
        return this._settings.get_strv('alarms')
            .filter(a => /^\d{1,2}:\d{2}$/.test(a))
            .map(a => a.padStart(5, '0'))
            .sort();
    }

    // Next alarm as "HH:MM", or null.
    get next() {
        const now = GLib.DateTime.new_now_local().format('%H:%M');
        const alarms = this.alarms;
        return alarms.find(a => a > now) ?? alarms[0] ?? null;
    }

    _check() {
        const now = GLib.DateTime.new_now_local();
        const hm = now.format('%H:%M');
        const key = `${now.format('%F')} ${hm}`;
        if (this.alarms.includes(hm) && !this._rung.has(key)) {
            this._rung.add(key);
            this.emit('ring', {time: hm});
        }
    }

    destroy() {
        GLib.source_remove(this._id);
        this.disconnectAll();
    }
}

export function formatTime(ms) {
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function formatUs(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
