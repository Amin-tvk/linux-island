// Small system watchers that feed the island: Bluetooth devices, the
// microphone / camera / screen-recording privacy state, the clipboard,
// upcoming calendar events and the weather.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import * as Weather from 'resource:///org/gnome/shell/misc/weather.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

// ---- Bluetooth -------------------------------------------------------------

// Emits 'event' {kind: 'bt-connected'|'bt-disconnected', name, iconName, percent}.
export class BluetoothWatcher extends EventEmitter {
    constructor() {
        super();
        this._cancellable = new Gio.Cancellable();
        this._timeouts = new Set();
        this._subId = Gio.DBus.system.signal_subscribe('org.bluez',
            'org.freedesktop.DBus.Properties', 'PropertiesChanged', null,
            'org.bluez.Device1', Gio.DBusSignalFlags.NONE,
            (_c, _s, path, _i, _sig, params) => {
                const [, changed] = params.deepUnpack();
                if (changed.Connected !== undefined)
                    this._onConnected(path, changed.Connected.deepUnpack());
            });
    }

    async _getAll(path, iface) {
        try {
            const res = await new Promise((resolve, reject) => {
                Gio.DBus.system.call('org.bluez', path, 'org.freedesktop.DBus.Properties', 'GetAll',
                    new GLib.Variant('(s)', [iface]), null, Gio.DBusCallFlags.NONE, 2000,
                    this._cancellable, (c, r) => {
                        try {
                            resolve(c.call_finish(r));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            return res.recursiveUnpack()[0];
        } catch {
            return null;
        }
    }

    _onConnected(path, connected) {
        // The battery level is often published a moment after connecting.
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, connected ? 1500 : 0, () => {
            this._timeouts.delete(id);
            this._report(path, connected).catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    async _report(path, connected) {
        const device = await this._getAll(path, 'org.bluez.Device1');
        if (!device)
            return;
        const battery = connected ? await this._getAll(path, 'org.bluez.Battery1') : null;
        const icon = device.Icon || 'bluetooth';
        this.emit('event', {
            kind: connected ? 'bt-connected' : 'bt-disconnected',
            name: device.Alias || device.Name || 'Bluetooth device',
            iconName: `${icon}-symbolic`,
            percent: battery?.Percentage ?? null,
        });
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.system.signal_unsubscribe(this._subId);
        this._timeouts.forEach(id => GLib.source_remove(id));
        this.disconnectAll();
    }
}

// ---- Privacy: microphone, camera, screen recording -------------------------

// Apps that show input levels and would otherwise look like recording.
const MIC_IGNORED = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

// Emits 'changed'; read .mic, .camera, .recording, .recordingStart.
export class PrivacyWatcher extends EventEmitter {
    constructor() {
        super();
        this.mic = false;
        this.camera = false;
        this.recording = false;
        this.recordingStart = 0;

        this._camera = new Shell.CameraMonitor();
        this._camera.connectObject('notify::cameras-in-use', () => this._sync(), this);

        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'stream-added', () => this._sync(),
            'stream-removed', () => this._sync(),
            'state-changed', () => this._sync(), this);

        Main.screenshotUI.connectObject('notify::screencast-in-progress', () => this._sync(), this);
        this._sync();
    }

    _micInUse() {
        if (this._control.get_state() !== Gvc.MixerControlState.READY)
            return false;
        return this._control.get_source_outputs().some(output => {
            // Our own visualizer records the speakers, not the microphone.
            const name = output.get_name() ?? '';
            return !MIC_IGNORED.includes(output.get_application_id()) &&
                !name.includes('Linux Island');
        });
    }

    _sync() {
        const mic = this._micInUse();
        const camera = this._camera.cameras_in_use;
        const recording = !!Main.screenshotUI.screencast_in_progress;
        if (recording && !this.recording)
            this.recordingStart = GLib.get_monotonic_time();
        if (mic === this.mic && camera === this.camera && recording === this.recording)
            return;
        this.mic = mic;
        this.camera = camera;
        this.recording = recording;
        this.emit('changed');
    }

    stopRecording() {
        Main.screenshotUI.stopScreencast();
    }

    destroy() {
        this._camera.disconnectObject(this);
        this._control.disconnectObject(this);
        Main.screenshotUI.disconnectObject(this);
        this._camera = null;
        this.disconnectAll();
    }
}

// ---- Clipboard -------------------------------------------------------------

// Emits 'copied' {text|null, image: bool}. Password managers mark secrets
// with x-kde-passwordManagerHint; those are never shown.
export class ClipboardWatcher extends EventEmitter {
    constructor() {
        super();
        this.muted = false;
        this._last = null;
        this._lastTime = 0;
        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD && !this.muted)
                this._onChanged();
        }, this);
    }

    _onChanged() {
        const types = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
        if (types.length === 0 || types.includes('x-kde-passwordManagerHint'))
            return;
        if (types.some(t => t.startsWith('image/')) && !types.some(t => t.startsWith('text/'))) {
            this._report(null, true);
            return;
        }
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (text)
                this._report(text, false);
        });
    }

    _report(text, image) {
        // Clipboard managers re-own the selection with the same content.
        const key = image ? '<image>' : text;
        const now = GLib.get_monotonic_time();
        if (key === this._last && now - this._lastTime < 3e6)
            return;
        this._last = key;
        this._lastTime = now;
        this.emit('copied', {text, image});
    }

    destroy() {
        this._selection.disconnectObject(this);
        this.disconnectAll();
    }
}

// ---- Calendar --------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;

// Emits 'reminder' {summary, start: Date, minutes} and 'changed' (next event).
export class CalendarWatcher extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._source = new Calendar.DBusEventSource();
        this._source.connectObject('changed', () => this.emit('changed'), this);
        this._notified = new Set();
        this._refresh();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30 * 60, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        const now = new Date();
        this._source.requestRange(new Date(now.getTime() - 3600 * 1000), new Date(now.getTime() + DAY_MS));
    }

    // Timed events of the coming day (all-day ones are skipped).
    upcoming() {
        const now = new Date();
        return this._source.getEvents(now, new Date(now.getTime() + DAY_MS))
            .filter(e => e.date > now && e.end - e.date < DAY_MS)
            .sort((a, b) => a.date - b.date);
    }

    get next() {
        return this.upcoming()[0] ?? null;
    }

    _check() {
        const lead = this._settings.get_int('meeting-reminder');
        if (lead <= 0)
            return;
        const now = Date.now();
        for (const e of this.upcoming()) {
            const minutes = Math.round((e.date - now) / 60000);
            const key = `${e.id}@${e.date.getTime()}`;
            if (minutes <= lead && !this._notified.has(key)) {
                this._notified.add(key);
                this.emit('reminder', {summary: e.summary, start: e.date, minutes: Math.max(0, minutes)});
            }
        }
    }

    openCalendar() {
        Main.panel.statusArea.dateMenu?.menu.open();
    }

    destroy() {
        GLib.source_remove(this._tickId);
        GLib.source_remove(this._refreshId);
        this._source.disconnectObject(this);
        this._source.destroy?.();
        this.disconnectAll();
    }
}

// ---- Weather ---------------------------------------------------------------

// Emits 'changed'; .text like "21 °C", .iconName, or null when unknown.
export class WeatherWatcher extends EventEmitter {
    constructor() {
        super();
        this.text = null;
        this.iconName = null;
        try {
            this._client = new Weather.WeatherClient();
            this._client.connectObject('changed', () => this._sync(), this);
            this._client.update();
            this._updateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30 * 60, () => {
                this._client.update();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) {
            console.debug(`linux-island: weather unavailable: ${e.message}`);
        }
    }

    _sync() {
        const info = this._client?.info;
        if (this._client?.hasLocation && !this._client.loading && info?.is_valid()) {
            this.text = info.get_temp_summary();
            this.iconName = info.get_symbolic_icon_name();
        } else {
            this.text = null;
            this.iconName = null;
        }
        this.emit('changed');
    }

    destroy() {
        if (this._updateId)
            GLib.source_remove(this._updateId);
        this._client?.disconnectObject(this);
        this._client = null;
        this.disconnectAll();
    }
}

// ---- Phone battery (UPower, over Bluetooth) -------------------------------

const UPOWER = 'org.freedesktop.UPower';
const UPOWER_DEVICE = 'org.freedesktop.UPower.Device';
const TYPE_PHONE = 8;
const PHONE_LOW = [20, 10];

// Emits 'changed' and 'low' {model, percent}. .phones: [{path, model, percent}].
export class PhoneBatteryWatcher extends EventEmitter {
    constructor() {
        super();
        this._phones = new Map();
        this._warned = new Map();
        this._cancellable = new Gio.Cancellable();
        const bus = Gio.DBus.system;
        this._subs = [
            bus.signal_subscribe(UPOWER, UPOWER, 'DeviceAdded', '/org/freedesktop/UPower', null,
                Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => this._add(params.deepUnpack()[0])),
            bus.signal_subscribe(UPOWER, UPOWER, 'DeviceRemoved', '/org/freedesktop/UPower', null,
                Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    if (this._phones.delete(params.deepUnpack()[0]))
                        this.emit('changed');
                }),
            bus.signal_subscribe(UPOWER, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null,
                UPOWER_DEVICE, Gio.DBusSignalFlags.NONE, (_c, _s, path) => {
                    if (this._phones.has(path))
                        this._add(path);
                }),
        ];
        bus.call(UPOWER, '/org/freedesktop/UPower', UPOWER, 'EnumerateDevices', null, null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    conn.call_finish(res).deepUnpack()[0].forEach(path => this._add(path));
                } catch {
                    // No UPower.
                }
            });
    }

    _add(path) {
        Gio.DBus.system.call(UPOWER, path, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [UPOWER_DEVICE]), null, Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (conn, res) => {
                let props;
                try {
                    props = conn.call_finish(res).recursiveUnpack()[0];
                } catch {
                    return;
                }
                if (props.Type !== TYPE_PHONE || !props.IsPresent)
                    return;
                const percent = Math.round(props.Percentage);
                const phone = {path, model: props.Model || 'Phone', percent};
                this._phones.set(path, phone);
                const level = PHONE_LOW.filter(l => percent <= l).pop();
                if (level !== undefined && this._warned.get(path) !== level) {
                    this._warned.set(path, level);
                    this.emit('low', phone);
                } else if (level === undefined) {
                    this._warned.delete(path);
                }
                this.emit('changed');
            });
    }

    get phones() {
        return [...this._phones.values()];
    }

    destroy() {
        this._cancellable.cancel();
        this._subs.forEach(id => Gio.DBus.system.signal_unsubscribe(id));
        this.disconnectAll();
    }
}

// ---- Phone info over GSConnect (Wi-Fi) ------------------------------------

const GSC_NAME = 'org.gnome.Shell.Extensions.GSConnect';
const GSC_ROOT = '/org/gnome/Shell/Extensions/GSConnect';
const GSC_DEVICE = 'org.gnome.Shell.Extensions.GSConnect.Device';

// Emits 'changed' and 'charging' {name, level}. .phone is the first
// connected, paired phone: {name, connected, level, charging,
// batteryIcon, signalIcon, network} (level -1 = unknown).
export class GSConnectPhones extends EventEmitter {
    constructor() {
        super();
        this._devices = new Map();
        this._cancellable = new Gio.Cancellable();
        const bus = Gio.DBus.session;
        this._subs = [
            bus.signal_subscribe(GSC_NAME, 'org.freedesktop.DBus.ObjectManager', null, GSC_ROOT, null,
                Gio.DBusSignalFlags.NONE, () => this._load()),
            bus.signal_subscribe(GSC_NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null,
                GSC_DEVICE, Gio.DBusSignalFlags.NONE, (_c, _s, path) => this._refresh(path)),
            bus.signal_subscribe(GSC_NAME, 'org.gtk.Actions', 'Changed', null, null,
                Gio.DBusSignalFlags.NONE, (_c, _s, path) => {
                    if (this._devices.has(path))
                        this._refresh(path);
                }),
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', GSC_NAME, Gio.DBusSignalFlags.NONE, () => this._load()),
        ];
        this._load();
    }

    _call(path, iface, method, params) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(GSC_NAME, path, iface, method, params, null,
                Gio.DBusCallFlags.NONE, 3000, this._cancellable, (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _load() {
        let objects = {};
        try {
            [objects] = (await this._call(GSC_ROOT, 'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects', null)).recursiveUnpack();
        } catch {
            // GSConnect not running.
        }
        const paths = Object.keys(objects).filter(p => objects[p][GSC_DEVICE]);
        for (const path of [...this._devices.keys()]) {
            if (!paths.includes(path))
                this._devices.delete(path);
        }
        await Promise.all(paths.map(p => this._refresh(p)));
        this.emit('changed');
    }

    async _state(path, action) {
        try {
            const [[, , state]] = (await this._call(path, 'org.gtk.Actions', 'Describe',
                new GLib.Variant('(s)', [action]))).deepUnpack();
            return state[0]?.deepUnpack() ?? null;
        } catch {
            return null; // plugin disabled
        }
    }

    async _refresh(path) {
        let props;
        try {
            [props] = (await this._call(path, 'org.freedesktop.DBus.Properties', 'GetAll',
                new GLib.Variant('(s)', [GSC_DEVICE]))).recursiveUnpack();
        } catch {
            return;
        }
        const old = this._devices.get(path);
        const device = {
            name: props.Name, type: props.Type, connected: props.Connected, paired: props.Paired,
            level: -1, charging: false, batteryIcon: null, signalIcon: null, network: '',
        };
        const battery = await this._state(path, 'battery');
        if (battery)
            [device.charging, device.batteryIcon, device.level] = battery;
        const net = await this._state(path, 'connectivityReport');
        if (net && net[2] >= 0) {
            device.network = net[0];
            device.signalIcon = net[3];
        }
        this._devices.set(path, device);
        if (old && device.connected && device.charging && !old.charging && device.level >= 0)
            this.emit('charging', {name: device.name, level: device.level});
        this.emit('changed');
    }

    get phone() {
        return [...this._devices.values()].find(d => d.paired && d.connected && d.type === 'phone') ?? null;
    }

    destroy() {
        this._cancellable.cancel();
        this._subs.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        this.disconnectAll();
    }
}

// ---- Do Not Disturb --------------------------------------------------------

export class FocusMode {
    constructor() {
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    }

    get active() {
        return !this._settings.get_boolean('show-banners');
    }

    toggle() {
        this._settings.set_boolean('show-banners', this.active);
        return this.active;
    }

    connect(callback) {
        return this._settings.connect('changed::show-banners', callback);
    }

    disconnect(id) {
        this._settings.disconnect(id);
    }
}
