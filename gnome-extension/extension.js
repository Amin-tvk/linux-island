import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtLoader} from './art.js';
import {Island} from './island.js';
import {MprisWatcher} from './mpris.js';
import {NotificationWatcher} from './notifications.js';
import {Timer} from './timer.js';

export default class LinuxIslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._art = new ArtLoader();
        this._mpris = new MprisWatcher();
        this._notifications = new NotificationWatcher(this._settings);
        this._timer = new Timer();
        this._island = new Island({
            settings: this._settings,
            mpris: this._mpris,
            notifications: this._notifications,
            timer: this._timer,
            art: this._art,
            openPrefs: () => this.openPreferences(),
        });

        Main.wm.addKeybinding('toggle-island', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._island.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-island');
        this._island.destroy();
        this._island = null;
        this._timer.destroy();
        this._timer = null;
        this._notifications.destroy();
        this._notifications = null;
        this._mpris.destroy();
        this._mpris = null;
        this._art.destroy();
        this._art = null;
        this._settings = null;
    }
}
