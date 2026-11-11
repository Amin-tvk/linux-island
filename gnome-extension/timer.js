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
