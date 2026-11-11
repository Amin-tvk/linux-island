// System events shown in the island: volume / brightness OSD, battery and
// charger changes, and scroll-to-change-volume.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

// Routes GNOME's OSD for the primary monitor (volume, brightness, keyboard
// layout…) into the island while @isEnabled() is true.
export class OsdRedirect extends EventEmitter {
    constructor(isEnabled) {
        super();
        const manager = Main.osdWindowManager;
        const self = this;
        const proto = Object.getPrototypeOf(manager);
        this._manager = manager;
        this._proto = proto;
        this._orig = manager._showOsdWindow ?? proto._showOsdWindow;
        const redirect = function (monitorIndex, icon, label, level, maxLevel) {
            if (isEnabled() && monitorIndex === Main.layoutManager.primaryIndex) {
                self.emit('osd', {icon, label, level, maxLevel});
                return;
            }
            self._orig.call(this, monitorIndex, icon, label, level, maxLevel);
        };
        // Patch both so another extension that only replaces one still loses
        // to us when we own the active path, and destroy can restore cleanly.
        manager._showOsdWindow = redirect;
        proto._showOsdWindow = redirect;
    }

    destroy() {
        if (this._manager._showOsdWindow)
            this._manager._showOsdWindow = this._orig.bind(this._manager);
        if (this._proto._showOsdWindow)
            this._proto._showOsdWindow = this._orig;
        this.disconnectAll();
    }
}

let _soundSettings = null;
function soundSettings() {
    return _soundSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
}

export function changeVolume(steps) {
    const control = Volume.getMixerControl();
    const sink = control?.get_default_sink();
    if (!sink)
        return;
    const norm = control.get_vol_max_norm();
    const allowAmp = soundSettings().get_boolean('allow-volume-above-100-percent');
    const max = allowAmp ? control.get_vol_max_amplified() : norm;
    const volume = Math.max(0, Math.min(max, sink.volume + steps * norm * 0.05));
    sink.volume = volume;
    if (sink.is_muted && volume > 0)
        sink.change_is_muted(false);
    sink.push_volume();

    // Same units GNOME's volume indicator uses for the OSD.
    const level = volume / norm;
    const maxLevel = max / norm;
    const name = volume === 0 || sink.is_muted ? 'muted'
        : level < 0.34 ? 'low' : level < 0.67 ? 'medium' : 'high';
    Main.osdWindowManager.showOne(Main.layoutManager.primaryIndex,
        new Gio.ThemedIcon({name: `audio-volume-${name}-symbolic`}), null, level, maxLevel);
}

const UPowerDevice = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="IsPresent" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IconName" type="s" access="read"/>
  </interface>
</node>`);

const CHARGING = 1, DISCHARGING = 2, FULL = 4;
const LOW_LEVELS = [20, 10, 5];

// Emits 'event' {kind: 'charging'|'unplugged'|'full'|'low', percent, iconName}.
export class BatteryWatcher extends EventEmitter {
    constructor() {
        super();
        this._cancellable = new Gio.Cancellable();
        this._state = null;
        this._warned = new Set();
        this._proxy = new UPowerDevice(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', (proxy, error) => {
                if (error)
                    return;
                this._state = proxy.State;
                this._propsId = proxy.connect('g-properties-changed', () => this._sync());
            }, this._cancellable);
    }

    _sync() {
        const p = this._proxy;
        if (!p.IsPresent)
            return;
        const percent = Math.round(p.Percentage);
        const info = {percent, iconName: p.IconName || 'battery-symbolic'};
        const old = this._state;
        this._state = p.State;

        if (p.State !== old) {
            if (p.State === CHARGING)
                this.emit('event', {kind: 'charging', ...info});
            else if (p.State === FULL && old === CHARGING)
                this.emit('event', {kind: 'full', ...info});
            else if (p.State === DISCHARGING && (old === CHARGING || old === FULL))
                this.emit('event', {kind: 'unplugged', ...info});
            if (p.State !== DISCHARGING)
                this._warned.clear();
        }

        if (p.State === DISCHARGING) {
            const level = LOW_LEVELS.find(l => percent <= l && !this._warned.has(l));
            if (level !== undefined) {
                LOW_LEVELS.filter(l => l >= level).forEach(l => this._warned.add(l));
                this.emit('event', {kind: 'low', ...info});
            }
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._propsId)
            this._proxy.disconnect(this._propsId);
        this.disconnectAll();
    }
}
