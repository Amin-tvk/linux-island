// Listens to GNOME's message tray and hands banner-worthy notifications to
// the island. Optionally keeps GNOME's own banner from appearing as well.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

export class NotificationWatcher extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        const tray = Main.messageTray;

        tray.connectObject(
            'source-added', (_t, source) => this._watch(source),
            'source-removed', (_t, source) => source.disconnectObject(this),
            this);
        tray.getSources().forEach(s => this._watch(s));

        // Banners are taken from the tray's queue in _showNotification();
        // drop the ones the island already shows. Critical ones (alarms,
        // low battery…) still get GNOME's banner so their buttons work.
        const watcher = this;
        const orig = MessageTray.MessageTray.prototype._showNotification;
        tray._showNotification = function () {
            if (watcher.replacing) {
                while (this._notificationQueue.length > 0 &&
                       this._notificationQueue[0].urgency !== MessageTray.Urgency.CRITICAL)
                    this._notificationQueue.shift();
                this.emit('queue-changed');
                if (this._notificationQueue.length === 0)
                    return;
            }
            orig.call(this);
        };
    }

    get enabled() {
        return this._settings.get_boolean('show-notifications');
    }

    get replacing() {
        return this.enabled && !this.blocked &&
            this._settings.get_boolean('replace-banners');
    }

    _watch(source) {
        source.connectObject('notification-request-banner',
            (_s, n) => this._onBanner(n), this);
    }

    // Same rules GNOME uses before showing a banner.
    _onBanner(n) {
        if (!this.enabled || this.blocked)
            return;
        if (n.acknowledged || n.urgency === MessageTray.Urgency.LOW)
            return;
        if (!n.source.policy.showBanners && n.urgency !== MessageTray.Urgency.CRITICAL)
            return;
        if (!Main.sessionMode.hasNotifications)
            return;
        this.emit('notification', n);
    }

    destroy() {
        delete Main.messageTray._showNotification;
        Main.messageTray.disconnectObject(this);
        Main.messageTray.getSources().forEach(s => s.disconnectObject(this));
        this.disconnectAll();
    }
}
