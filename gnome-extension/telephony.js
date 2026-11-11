// Phone calls over Bluetooth. When a phone is connected with the
// Hands-Free profile, PipeWire publishes an Audio Gateway on
// org.pipewire.Telephony. Calls are announced via ofono's
// VoiceCallManager (CallAdded/CallRemoved) and also as
// org.pipewire.Telephony.Call1 objects — the island can show them,
// answer and hang up, and call audio then goes through the laptop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'org.pipewire.Telephony';
const ROOT = '/org/pipewire/Telephony';
const CALL_IFACE = 'org.pipewire.Telephony.Call1';
const AG_IFACE = 'org.pipewire.Telephony.AudioGateway1';
const OFONO_VCM = 'org.ofono.VoiceCallManager';
const OFONO_CALL = 'org.ofono.VoiceCall';

// States from the Hands-Free / ofono VoiceCall profile.
const RINGING = ['incoming', 'waiting'];
const LIVE = ['active', 'held', 'dialing', 'alerting'];

// Emits 'changed'. .ringing and .live are the current call or null:
// {path, number, name, state, start}.
export class BluetoothCalls extends EventEmitter {
    constructor() {
        super();
        this._calls = new Map();
        this._gateways = new Map(); // path -> {subs: number[]}
        this._cancellable = new Gio.Cancellable();
        const bus = Gio.DBus.session;

        this._subs = [
            // AGs (and Call1 objects) can appear under ROOT or under an AG.
            bus.signal_subscribe(BUS_NAME, 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded',
                null, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path, ifaces] = params.recursiveUnpack();
                    if (ifaces[AG_IFACE])
                        this._watchGateway(path);
                    if (ifaces[CALL_IFACE] || ifaces[OFONO_CALL])
                        this._set(path, {...(ifaces[CALL_IFACE] ?? {}), ...(ifaces[OFONO_CALL] ?? {})});
                }),
            bus.signal_subscribe(BUS_NAME, 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved',
                null, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path, ifaces] = params.deepUnpack();
                    if (ifaces.includes(AG_IFACE))
                        this._unwatchGateway(path);
                    if ((ifaces.includes(CALL_IFACE) || ifaces.includes(OFONO_CALL)) &&
                        this._calls.delete(path))
                        this.emit('changed');
                }),
            bus.signal_subscribe(BUS_NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                null, CALL_IFACE, Gio.DBusSignalFlags.NONE, (_c, _s, path, _i, _n, params) => {
                    const [, changed] = params.recursiveUnpack();
                    this._set(path, changed);
                }),
            // ofono VoiceCall uses PropertyChanged (s, v), not PropertiesChanged.
            bus.signal_subscribe(BUS_NAME, OFONO_CALL, 'PropertyChanged',
                null, null, Gio.DBusSignalFlags.NONE, (_c, _s, path, _i, _n, params) => {
                    const [key, value] = params.deepUnpack();
                    this._set(path, {[key]: value.deepUnpack?.() ?? value});
                }),
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', BUS_NAME, Gio.DBusSignalFlags.NONE, () => {
                    for (const path of [...this._gateways.keys()])
                        this._unwatchGateway(path);
                    this._calls.clear();
                    this.emit('changed');
                    this._load();
                }),
        ];
        this._load();
    }

    _load() {
        Gio.DBus.session.call(BUS_NAME, ROOT, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
            null, null, Gio.DBusCallFlags.NO_AUTO_START, 2000, this._cancellable, (conn, res) => {
                try {
                    const [objects] = conn.call_finish(res).recursiveUnpack();
                    for (const [path, ifaces] of Object.entries(objects)) {
                        if (ifaces[AG_IFACE])
                            this._watchGateway(path);
                        if (ifaces[CALL_IFACE] || ifaces[OFONO_CALL])
                            this._set(path, {...(ifaces[CALL_IFACE] ?? {}), ...(ifaces[OFONO_CALL] ?? {})});
                    }
                } catch {
                    // No PipeWire telephony: nothing to show.
                }
            });
    }

    _watchGateway(agPath) {
        if (this._gateways.has(agPath))
            return;
        console.log(`linux-island: bluetooth gateway ${agPath}`);
        const bus = Gio.DBus.session;
        const subs = [
            bus.signal_subscribe(BUS_NAME, OFONO_VCM, 'CallAdded',
                agPath, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path, props] = params.recursiveUnpack();
                    this._set(path, props);
                }),
            bus.signal_subscribe(BUS_NAME, OFONO_VCM, 'CallRemoved',
                agPath, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const [path] = params.deepUnpack();
                    if (this._calls.delete(path))
                        this.emit('changed');
                }),
        ];
        this._gateways.set(agPath, {subs});

        // Existing calls (e.g. extension loaded mid-ring).
        Gio.DBus.session.call(BUS_NAME, agPath, OFONO_VCM, 'GetCalls',
            null, null, Gio.DBusCallFlags.NO_AUTO_START, 2000, this._cancellable, (conn, res) => {
                try {
                    const [calls] = conn.call_finish(res).recursiveUnpack();
                    for (const [path, props] of Object.entries(calls))
                        this._set(path, props);
                } catch (e) {
                    console.debug(`linux-island: GetCalls ${agPath}: ${e.message}`);
                }
            });

        // Also walk the AG's ObjectManager in case Call1 objects are already there.
        Gio.DBus.session.call(BUS_NAME, agPath, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
            null, null, Gio.DBusCallFlags.NO_AUTO_START, 2000, this._cancellable, (conn, res) => {
                try {
                    const [objects] = conn.call_finish(res).recursiveUnpack();
                    for (const [path, ifaces] of Object.entries(objects)) {
                        if (ifaces[CALL_IFACE] || ifaces[OFONO_CALL])
                            this._set(path, {...(ifaces[CALL_IFACE] ?? {}), ...(ifaces[OFONO_CALL] ?? {})});
                    }
                } catch {
                    // Optional.
                }
            });
    }

    _unwatchGateway(agPath) {
        const gw = this._gateways.get(agPath);
        if (!gw)
            return;
        gw.subs.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        this._gateways.delete(agPath);
        // Drop calls that lived under this gateway.
        for (const path of [...this._calls.keys()]) {
            if (path.startsWith(`${agPath}/`) || path === agPath)
                this._calls.delete(path);
        }
        this.emit('changed');
    }

    _set(path, props) {
        const old = this._calls.get(path);
        const call = {path, number: '', name: '', state: '', start: 0, ...old};
        // Props may arrive as plain values (ofono CallAdded) or still-packed.
        const read = (key, ...aliases) => {
            for (const k of [key, ...aliases]) {
                if (props[k] === undefined)
                    continue;
                let v = props[k];
                if (v && typeof v === 'object' && typeof v.deepUnpack === 'function')
                    v = v.deepUnpack();
                return v;
            }
            return undefined;
        };
        const number = read('LineIdentification', 'IncomingLine');
        const name = read('Name');
        const state = read('State');
        if (number !== undefined)
            call.number = number ?? '';
        if (name !== undefined)
            call.name = name ?? '';
        if (state !== undefined)
            call.state = state ?? '';
        if (call.state === 'active' && !call.start)
            call.start = GLib.get_monotonic_time();
        if (call.state !== old?.state)
            console.log(`linux-island: bluetooth call ${path.split('/').slice(-2).join('/')}: ${old?.state ?? 'new'} -> ${call.state || '?'}`);
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
        // Prefer Call1, fall back to ofono VoiceCall (same Answer/Hangup).
        const tryIface = (iface, next) => {
            Gio.DBus.session.call(BUS_NAME, path, iface, method, null, null,
                Gio.DBusCallFlags.NONE, 5000, null, (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        if (next)
                            next();
                        else
                            console.warn(`linux-island: ${method} failed: ${e.message}`);
                    }
                });
        };
        tryIface(CALL_IFACE, () => tryIface(OFONO_CALL, null));
    }

    answer(path) {
        this._callMethod(path, 'Answer');
    }

    hangup(path) {
        this._callMethod(path, 'Hangup');
    }

    destroy() {
        this._cancellable.cancel();
        for (const path of [...this._gateways.keys()])
            this._unwatchGateway(path);
        this._subs.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        this.disconnectAll();
    }
}

// "+989121234567" -> "+98 912 123 4567"; other formats are left alone.
export function formatNumber(number) {
    const m = /^\+98(\d{3})(\d{3})(\d{4})$/.exec(number ?? '');
    return m ? `+98 ${m[1]} ${m[2]} ${m[3]}` : number ?? '';
}
