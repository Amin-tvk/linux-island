import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LinuxIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const switchRow = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const spinRow = (key, title, lower, upper) => {
            const row = new Adw.SpinRow({
                title,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const content = new Adw.PreferencesGroup({title: 'What to show'});
        content.add(switchRow('show-media', 'Now playing', 'Any app that supports MPRIS: browsers, Spotify, VLC, Rhythmbox…'));
        content.add(switchRow('show-notifications', 'Notifications'));
        content.add(switchRow('replace-banners', 'Hide GNOME banners',
            'Show notifications only in the island. They still appear in the message list.'));
        page.add(content);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        behaviour.add(switchRow('expand-on-hover', 'Expand on hover'));
        behaviour.add(switchRow('hide-when-idle', 'Hide when idle', 'Use the shortcut to open the clock and timer'));
        behaviour.add(spinRow('top-margin', 'Gap below the top bar (px)', 0, 200));
        behaviour.add(spinRow('notification-duration', 'Notification time (seconds)', 2, 30));
        page.add(behaviour);

        const extra = new Adw.PreferencesGroup({title: 'Timer & shortcut'});
        const presets = new Adw.EntryRow({
            title: 'Timer presets in minutes (comma separated)',
            text: settings.get_value('timer-presets').deepUnpack().join(', '),
            show_apply_button: true,
        });
        presets.connect('apply', () => {
            const values = presets.text.split(/[,\s]+/).map(Number)
                .filter(n => Number.isInteger(n) && n > 0 && n <= 24 * 60).slice(0, 6);
            if (values.length)
                settings.set_value('timer-presets', new GLib.Variant('ai', values));
            presets.text = settings.get_value('timer-presets').deepUnpack().join(', ');
        });
        extra.add(presets);

        const shortcut = new Adw.EntryRow({
            title: 'Toggle shortcut (e.g. <Super><Alt>h)',
            text: settings.get_strv('toggle-island')[0] ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const [ok] = Gtk.accelerator_parse(shortcut.text);
            if (ok || shortcut.text === '')
                settings.set_strv('toggle-island', shortcut.text ? [shortcut.text] : []);
            else
                shortcut.text = settings.get_strv('toggle-island')[0] ?? '';
        });
        extra.add(shortcut);
        page.add(extra);
    }
}
