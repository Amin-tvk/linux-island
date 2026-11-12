import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VISUALIZER_MODES = [['line', 'Outline pulse'], ['bars', 'Mini spectrum']];

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

        look.add(switchRow('visualizer-enabled', 'Music visualizer',
            'A subtle effect that follows the sound that is playing'));
        const visualizer = new Adw.ComboRow({
            title: 'Visualizer style',
            model: Gtk.StringList.new(VISUALIZER_MODES.map(([, name]) => name)),
        });
        const syncVisualizer = () => {
            visualizer.selected = Math.max(0, VISUALIZER_MODES.findIndex(([id]) => id === settings.get_string('visualizer')));
        };
        syncVisualizer();
        settings.connect('changed::visualizer', syncVisualizer);
        visualizer.connect('notify::selected', () =>
            settings.set_string('visualizer', VISUALIZER_MODES[visualizer.selected][0]));
        settings.bind('visualizer-enabled', visualizer, 'sensitive', Gio.SettingsBindFlags.GET);
        look.add(visualizer);
        look.add(switchRow('glow', 'Cover-colour glow'));
        look.add(switchRow('vinyl', 'Spinning record', 'The cover turns like a record while music plays'));
        look.add(switchRow('art-tint', 'Cover-colour edge', 'A thin edge in the colour of the album'));
        page.add(look);

        const content = new Adw.PreferencesGroup({title: 'What to show'});
        content.add(switchRow('show-media', 'Now playing', 'Any app that supports MPRIS: browsers, Spotify, VLC, Rhythmbox…'));
        content.add(switchRow('peek-on-track-change', 'Peek at new songs', 'Briefly expand when the track changes'));
        content.add(switchRow('screen-time', 'Screen time',
            'Time at the computer today and the most used apps. Stays on this computer'));
        content.add(switchRow('ghost-mode', 'Ghost mode while playing',
            'Fades away from the pointer and lets clicks through. Rest the pointer on it or hold Super to use it'));
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

        const phone = new Adw.PreferencesGroup({
            title: 'Phone',
            description: 'Incoming calls need the KDE Connect / GSConnect Phone permission on Android (not only notification sync). On Xiaomi/POCO also set battery usage to No restrictions. SMS and replies use notification sync.',
        });
        phone.add(switchRow('show-phone', 'Calls and phone messages',
            'Ringing calls get their own view with a Mute button; answered calls show a timer; replies go through your phone'));
        phone.add(spinRow('phone-battery-warning', 'Low phone battery alert (%)', 0, 50, 1, 0,
            'A red alert with a sound at this level and again at 10%; 0 turns it off'));
        page.add(phone);

        const system = new Adw.PreferencesGroup({title: 'System'});
        system.add(switchRow('show-bluetooth', 'Bluetooth devices', 'Headphones connecting, with their battery level'));
        system.add(switchRow('show-privacy', 'Privacy dots', 'Orange: microphone, green: camera, red: screen recording'));
        system.add(switchRow('clipboard-peek', 'Show what you copy', 'Password-manager copies are never shown'));
        system.add(switchRow('show-weather', 'Weather in the clock view', 'Uses the location set in GNOME Weather'));
        system.add(spinRow('meeting-reminder', 'Calendar reminder (minutes before, 0 = off)', 0, 60));
        page.add(system);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        behaviour.add(switchRow('expand-on-hover', 'Expand on hover'));
        behaviour.add(switchRow('scroll-volume', 'Scroll to change volume', 'Sideways scroll skips tracks'));
        behaviour.add(switchRow('hide-when-idle', 'Hide when idle', 'Use the shortcut to open the clock and timer'));
        behaviour.add(spinRow('notification-duration', 'Notification time (seconds)', 2, 30));
        behaviour.add(spinRow('monitor', 'Monitor (-1 = primary)', -1, 9));
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

        const alarms = new Adw.EntryRow({
            title: 'Daily alarms, HH:MM (comma separated)',
            text: settings.get_strv('alarms').join(', '),
            show_apply_button: true,
        });
        alarms.connect('apply', () => {
            const values = alarms.text.split(/[,\s]+/).filter(a => /^\d{1,2}:\d{2}$/.test(a))
                .filter(a => Number(a.split(':')[0]) < 24 && Number(a.split(':')[1]) < 60)
                .map(a => a.padStart(5, '0'));
            settings.set_strv('alarms', [...new Set(values)].sort());
            alarms.text = settings.get_strv('alarms').join(', ');
        });
        extra.add(alarms);

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
        const pomodoro = new Adw.PreferencesGroup({title: 'Pomodoro'});
        pomodoro.add(spinRow('pomodoro-focus', 'Focus (minutes)', 1, 180));
        pomodoro.add(spinRow('pomodoro-break', 'Break (minutes)', 1, 60));
        pomodoro.add(spinRow('pomodoro-long-break', 'Long break (minutes)', 1, 90));
        pomodoro.add(spinRow('pomodoro-rounds', 'Focus sessions before a long break', 2, 10));

        extra.add(shortcutRow('toggle-island', 'Open / close shortcut (e.g. &lt;Super&gt;&lt;Alt&gt;h)'));
        extra.add(shortcutRow('toggle-list', 'Notification list shortcut (e.g. &lt;Super&gt;&lt;Alt&gt;n)'));
        page.add(extra);
        page.add(pomodoro);
    }
}
