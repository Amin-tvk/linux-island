import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtLoader} from './art.js';
import {Island} from './island.js';
import {MprisWatcher} from './mpris.js';
import {NotificationWatcher} from './notifications.js';
import {QuickReply} from './reply.js';
import {BatteryWatcher, OsdRedirect} from './system.js';
import {AlarmClock, Pomodoro, Stopwatch, Timer} from './timer.js';
import {BluetoothCalls} from './telephony.js';
import {Spectrum} from './visualizer.js';
import {
    BluetoothWatcher, CalendarWatcher, ClipboardWatcher, FocusMode, GSConnectPhones, PhoneBatteryWatcher,
    PrivacyWatcher, WeatherWatcher,
} from './watchers.js';

export default class LinuxIslandExtension extends Extension {
    enable() {
        console.log(`linux-island: enable v${this.metadata.version ?? '?'}`);
        this._settings = this.getSettings();
        this._art = new ArtLoader();
        this._mpris = new MprisWatcher();
        this._notifications = new NotificationWatcher(this._settings);
        this._timer = new Timer();
        this._battery = new BatteryWatcher();
        this._osd = new OsdRedirect(() => this._settings.get_boolean('replace-osd'));
        this._spectrum = new Spectrum();
        this._reply = new QuickReply(this._settings);
        this._extras = {
            bluetooth: new BluetoothWatcher(),
            privacy: new PrivacyWatcher(),
            clipboard: new ClipboardWatcher(),
            calendar: new CalendarWatcher(this._settings),
            weather: new WeatherWatcher(),
            focus: new FocusMode(),
            stopwatch: new Stopwatch(),
            pomodoro: new Pomodoro(this._timer, this._settings),
            alarms: new AlarmClock(this._settings),
            btCalls: new BluetoothCalls(),
            phoneBattery: new PhoneBatteryWatcher(),
            gsconnect: new GSConnectPhones(),
        };
        this._island = new Island({
            settings: this._settings,
            mpris: this._mpris,
            notifications: this._notifications,
            timer: this._timer,
            art: this._art,
            battery: this._battery,
            osd: this._osd,
            spectrum: this._spectrum,
            reply: this._reply,
            extras: this._extras,
            openPrefs: () => this._openPrefs(),
        });

        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('toggle-island', this._settings,
            Meta.KeyBindingFlags.NONE, mode, () => this._island.toggle());
        Main.wm.addKeybinding('toggle-list', this._settings,
            Meta.KeyBindingFlags.NONE, mode, () => this._island.showList());
    }

    // openPreferences() fails without a trace when the call to the
    // Extensions service errors; ask it directly and fall back to the
    // command-line tool, which goes through the same service.
    _openPrefs() {
        Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions', 'OpenExtensionPrefs',
            new GLib.Variant('(ssa{sv})', [this.uuid, '', {}]),
            null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    console.warn(`linux-island: opening settings failed (${e.message}), using gnome-extensions`);
                    GLib.spawn_command_line_async(`gnome-extensions prefs ${this.uuid}`);
                }
            });
    }

    disable() {
        Main.wm.removeKeybinding('toggle-island');
        Main.wm.removeKeybinding('toggle-list');
        this._island.destroy();
        this._island = null;
        for (const watcher of Object.values(this._extras))
            watcher.destroy?.();
        this._extras = null;
        for (const name of ['_reply', '_spectrum', '_osd', '_battery', '_timer', '_notifications', '_mpris', '_art']) {
            this[name].destroy();
            this[name] = null;
        }
        this._settings = null;
    }
}
