import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VISUALIZER_MODES = [['bars', 'Bars around the island'], ['glow', 'Pulsing glow'], ['off', 'Off']];

export default class LinuxIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 760);
        const page = new Adw.PreferencesPage({icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const switchRow = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const spinRow = (key, title, lower, upper, step = 1, digits = 0, subtitle = '') => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                digits,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const look = new Adw.PreferencesGroup({title: 'Look'});
        look.add(spinRow('scale', 'Size', 0.7, 1.6, 0.05, 2, '1.00 is the default size'));
        look.add(spinRow('animation-speed', 'Animation speed', 0.5, 2.5, 0.1, 1, 'Higher is faster'));
        look.add(spinRow('top-margin', 'Gap below the top bar (px)', 0, 200));

        const visualizer = new Adw.ComboRow({
            title: 'Music visualizer',
            subtitle: 'Reacts to the sound that is playing',
            model: Gtk.StringList.new(VISUALIZER_MODES.map(([, name]) => name)),
        });
        const syncVisualizer = () => {
            visualizer.selected = Math.max(0, VISUALIZER_MODES.findIndex(([id]) => id === settings.get_string('visualizer')));
        };
        syncVisualizer();
        settings.connect('changed::visualizer', syncVisualizer);
        visualizer.connect('notify::selected', () =>
            settings.set_string('visualizer', VISUALIZER_MODES[visualizer.selected][0]));
        look.add(visualizer);
        look.add(switchRow('glow', 'Cover-colour glow'));
        page.add(look);

        const content = new Adw.PreferencesGroup({title: 'What to show'});
        content.add(switchRow('show-media', 'Now playing', 'Any app that supports MPRIS: browsers, Spotify, VLC, Rhythmbox…'));
        content.add(switchRow('peek-on-track-change', 'Peek at new songs', 'Briefly expand when the track changes'));
        content.add(switchRow('show-notifications', 'Notifications'));
        content.add(switchRow('replace-banners', 'Hide GNOME banners',
            'Show notifications only in the island. They still appear in the message list.'));
        content.add(switchRow('quick-reply', 'Reply from the island',
            'For messengers (Telegram, WhatsApp, Signal, Discord, Bale…): opens the chat, pastes your reply and sends it'));
        const replyApps = new Adw.EntryRow({
            title: 'Messenger apps (comma separated)',
            text: settings.get_strv('reply-apps').join(', '),
            show_apply_button: true,
        });
        replyApps.connect('apply', () => {
            settings.set_strv('reply-apps', replyApps.text.split(',').map(a => a.trim()).filter(Boolean));
            replyApps.text = settings.get_strv('reply-apps').join(', ');
        });
        content.add(replyApps);
        content.add(switchRow('replace-osd', 'Volume and brightness in the island'));
        content.add(switchRow('show-battery', 'Charger and low battery'));
        page.add(content);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        behaviour.add(switchRow('expand-on-hover', 'Expand on hover'));
        behaviour.add(switchRow('scroll-volume', 'Scroll to change volume', 'Sideways scroll skips tracks'));
        behaviour.add(switchRow('hide-when-idle', 'Hide when idle', 'Use the shortcut to open the clock and timer'));
        behaviour.add(spinRow('notification-duration', 'Notification time (seconds)', 2, 30));
        page.add(behaviour);

        const extra = new Adw.PreferencesGroup({title: 'Timer and shortcuts'});
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

        const shortcutRow = (key, title) => {
            const row = new Adw.EntryRow({
                title,
                text: settings.get_strv(key)[0] ?? '',
                show_apply_button: true,
            });
            row.connect('apply', () => {
                const [ok] = Gtk.accelerator_parse(row.text);
                if (ok || row.text === '')
                    settings.set_strv(key, row.text ? [row.text] : []);
                else
                    row.text = settings.get_strv(key)[0] ?? '';
            });
            return row;
        };
        extra.add(shortcutRow('toggle-island', 'Open / close shortcut (e.g. <Super><Alt>h)'));
        extra.add(shortcutRow('toggle-list', 'Notification list shortcut (e.g. <Super><Alt>n)'));
        page.add(extra);
    }
}
