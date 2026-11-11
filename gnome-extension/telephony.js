// Phone calls over Bluetooth. When a phone is connected with the
// Hands-Free profile, PipeWire publishes its calls on the session bus
// (org.pipewire.Telephony): the island can show them, answer and hang up,
// and the call audio then goes through the laptop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'org.pipewire.Telephony';
const ROOT = '/org/pipewire/Telephony';
const CALL_IFACE = 'org.pipewire.Telephony.Call1';

// States from the Hands-Free profile.
const RINGING = ['incoming', 'waiting'];
const LIVE = ['active', 'held', 'dialing', 'alerting'];

// Emits 'changed'. .ringing and .live are the current call or null:
// {path, number, name, state, start}.
export class BluetoothCalls extends EventEmitter {
    constructor() {
        super();
        this._calls = new Map();
        this._cancellable = new Gio.Cancellable();
        const bus = Gio.DBus.session;

        this._subs = [
            bus.signal_subscribe(BUS_NAME, 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded',
                ROOT, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path, ifaces] = params.recursiveUnpack();
                    if (ifaces[CALL_IFACE])
                        this._set(path, ifaces[CALL_IFACE]);
                }),
            bus.signal_subscribe(BUS_NAME, 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved',
                ROOT, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path, ifaces] = params.deepUnpack();
                    if (ifaces.includes(CALL_IFACE) && this._calls.delete(path))
                        this.emit('changed');
                }),
            bus.signal_subscribe(BUS_NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                null, CALL_IFACE, Gio.DBusSignalFlags.NONE, (_c, _s, path, _i, _n, params) => {
                    const [, changed] = params.recursiveUnpack();
                    if (this._calls.has(path))
                        this._set(path, changed);
                }),
            // PipeWire restarting drops every call.
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', BUS_NAME, Gio.DBusSignalFlags.NONE, () => {
                    this._calls.clear();
                    this.emit('changed');
                    this._load();
                }),
        ];
        this._load();
    }

    _load() {
        Gio.DBus.session.call(BUS_NAME, ROOT, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
            null, null, Gio.DBusCallFlags.NONE, 2000, this._cancellable, (conn, res) => {
                try {
                    const [objects] = conn.call_finish(res).recursiveUnpack();
                    for (const [path, ifaces] of Object.entries(objects)) {
                        if (ifaces[CALL_IFACE])
                            this._set(path, ifaces[CALL_IFACE]);
                    }
                } catch {
                    // No PipeWire telephony: nothing to show.
                }
            });
    }

    _set(path, props) {
        const old = this._calls.get(path);
        const call = {path, number: '', name: '', state: '', start: 0, ...old};
        if (props.LineIdentification !== undefined)
            call.number = props.LineIdentification;
        if (props.Name !== undefined)
            call.name = props.Name;
        if (props.State !== undefined)
            call.state = props.State;
        if (call.state === 'active' && !call.start)
            call.start = GLib.get_monotonic_time();
        if (call.state === 'disconnected')
            this._calls.delete(path);
        else
            this._calls.set(path, call);
        this.emit('changed');
    }

    get ringing() {
        return [...this._calls.values()].find(c => RINGING.includes(c.state)) ?? null;
    }

    get live() {
        return [...this._calls.values()].find(c => LIVE.includes(c.state)) ?? null;
    }

    _callMethod(path, method) {
        Gio.DBus.session.call(BUS_NAME, path, CALL_IFACE, method, null, null,
            Gio.DBusCallFlags.NONE, 5000, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    console.warn(`linux-island: ${method} failed: ${e.message}`);
                }
            });
    }

    answer(path) {
        this._callMethod(path, 'Answer');
    }

    hangup(path) {
        this._callMethod(path, 'Hangup');
    }

    destroy() {
        this._cancellable.cancel();
        this._subs.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        this.disconnectAll();
    }
}

// "+989121234567" -> "+98 912 123 4567"; other formats are left alone.
export function formatNumber(number) {
    const m = /^\+98(\d{3})(\d{3})(\d{4})$/.exec(number ?? '');
    return m ? `+98 ${m[1]} ${m[2]} ${m[3]}` : number ?? '';
}
