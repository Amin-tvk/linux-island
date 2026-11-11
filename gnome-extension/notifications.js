// Listens to GNOME's message tray and hands banner-worthy notifications to
// the island, keeps GNOME's own banner from appearing over it, and exposes
// the notification history.

import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {phoneKind} from './phone.js';

export class NotificationWatcher extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.blocked = false;
        const tray = Main.messageTray;

        tray.connectObject(
            'source-added', (_t, source) => this._watch(source),
            'source-removed', (_t, source) => source.disconnectObject(this),
            this);
        tray.getSources().forEach(s => this._watch(s));

    }

    get enabled() {
        return this._settings.get_boolean('show-notifications');
    }

    get replacing() {
        return this.enabled && this._settings.get_boolean('replace-banners');
    }

    // Our handler has to run before the tray's (and before other extensions
    // that hook the tray's handler, like notification-configurator) so it can
    // stop the banner. Handlers run in connection order, so move the tray's
    // handlers behind ours.
    _watch(source) {
        const tray = Main.messageTray;
        source.disconnectObject(this);
        source.disconnectObject(tray);
        source.connectObject('notification-request-banner',
            (s, n) => this._onBanner(s, n), this);
        source.connectObject(
            'notification-request-banner', tray._onNotificationRequestBanner.bind(tray),
            'notification-removed', tray._onNotificationRemoved.bind(tray),
            'destroy', () => tray._removeSource(source),
            tray);
        source.connectObject(
            'notification-added', (_s, n) => this._onAdded(n),
            'notification-removed', () => this.emit('history-changed'),
            this);
        this.emit('history-changed');
    }

    // Calls can be CRITICAL (GNOME keeps its own banner path) or added
    // without a banner request — still hand them to the island.
    _onAdded(n) {
        this.emit('history-changed');
        const kind = phoneKind(n);
        if (kind !== 'call' && kind !== 'ongoing')
            return;
        if (!this.enabled || this.blocked)
            return;
        this.emit('notification', n);
    }

    // Same rules GNOME uses before showing a banner.
    _onBanner(source, n) {
        if (!this.enabled || this.blocked)
            return;
        if (n.acknowledged || n.urgency === MessageTray.Urgency.LOW)
            return;
        const kind = phoneKind(n);
        // A ringing phone gets through Do Not Disturb.
        if (!n.source.policy.showBanners && n.urgency !== MessageTray.Urgency.CRITICAL && kind !== 'call')
            return;
        if (!Main.sessionMode.hasNotifications || Main.layoutManager.primaryMonitor?.inFullscreen)
            return;
        // Critical ones (low battery, alarms…) keep GNOME's banner; the
        // island steps aside while it is shown. A ringing phone is the
        // exception: the island has a call view for it.
        if (n.urgency === MessageTray.Urgency.CRITICAL && kind !== 'call')
            return;

        this.emit('notification', n);
        if (this.replacing)
            GObject.signal_stop_emission_by_name(source, 'notification-request-banner');
    }

    // ---- history -----------------------------------------------------------

    get history() {
        return Main.messageTray.getSources()
            .flatMap(s => s.notifications)
            .sort((a, b) => b.datetime.compare(a.datetime));
    }

    get unseenCount() {
        return Main.messageTray.getSources().reduce((sum, s) => sum + s.unseenCount, 0);
    }

    clearHistory() {
        for (const source of Main.messageTray.getSources()) {
            for (const n of [...source.notifications]) {
                if (!n.resident)
                    n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
            }
        }
    }

    markAllSeen() {
        Main.messageTray.getSources().forEach(s =>
            s.notifications.forEach(n => (n.acknowledged = true)));
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        Main.messageTray.getSources().forEach(s => s.disconnectObject(this));
        this.disconnectAll();
    }
}
