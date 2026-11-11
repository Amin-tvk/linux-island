// Quick reply: GNOME routes notification signals through a separate
// process that drops the freedesktop "NotificationReplied" signal, so true
// inline replies can't reach apps. Instead the island opens the chat (the
// notification's default action), waits until that app's window has focus,
// then pastes the text and presses Enter. If the app never takes focus,
// nothing is typed and the text stays on the clipboard.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {sourceApp} from './phone.js';

const RAISE_AFTER = 1200;
const FOCUS_TIMEOUT = 5000;
const SETTLE_TIME = 450;   // let the chat view open and focus its input
const PASTE_TIME = 400;
const RESTORE_TIME = 1500;

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function appKey(source) {
    const id = sourceApp(source)?.get_id?.() ?? '';
    return (id || source?.title || '').toLowerCase().replace(/\.desktop$/, '');
}

export class QuickReply {
    constructor(settings) {
        this._settings = settings;
        this._device = null;
    }

    // Messenger notifications only: replying to, say, a download finished
    // notification makes no sense.
    canReply(n) {
        if (!n || !this._settings.get_boolean('quick-reply'))
            return false;
        const key = `${appKey(n.source)} ${(n.source?.title ?? '').toLowerCase()}`;
        return this._settings.get_strv('reply-apps').some(a => a && key.includes(a.toLowerCase()));
    }

    _windowMatches(window, n) {
        if (!window)
            return false;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        if (sourceApp(n.source) && app === sourceApp(n.source))
            return true;
        const key = appKey(n.source);
        const winKey = [app?.get_id(), window.get_wm_class(), window.get_gtk_application_id()]
            .filter(Boolean).join(' ').toLowerCase();
        const name = (n.source?.title ?? '').toLowerCase();
        return (key && winKey.includes(key)) || (name.length > 2 && winKey.includes(name));
    }

    _press(keyval, down) {
        if (!this._device) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        this._device.notify_keyval(GLib.get_monotonic_time(), keyval,
            down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }

    _tap(keyval, modifier = null) {
        if (modifier)
            this._press(modifier, true);
        this._press(keyval, true);
        this._press(keyval, false);
        if (modifier)
            this._press(modifier, false);
    }

    _findWindow(n) {
        return global.display.list_all_windows()
            .filter(w => !w.skip_taskbar && this._windowMatches(w, n))
            .sort((a, b) => b.get_user_time() - a.get_user_time())[0] ?? null;
    }

    // Resolves to 'sent' or 'copied'.
    async send(n, text) {
        const log = msg => console.log(`linux-island: reply: ${msg}`);
        const clipboard = St.Clipboard.get_default();
        const previous = await new Promise(resolve =>
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, t) => resolve(t)));
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

        log(`app=${appKey(n.source)} title=${n.source?.title} destroyed=${!!n._destroyed}`);
        // The default action opens the chat the message came from.
        if (!n._destroyed)
            n.activate();
        Main.overview.hide();

        // Apps often open the chat but can't raise their own window on
        // Wayland (focus-stealing prevention); the shell can.
        const start = GLib.get_monotonic_time();
        let raised = false;
        while (!this._windowMatches(global.display.focus_window, n)) {
            const elapsed = (GLib.get_monotonic_time() - start) / 1000;
            if (!raised && elapsed > RAISE_AFTER) {
                raised = true;
                const window = this._findWindow(n);
                log(`not focused yet (focus=${global.display.focus_window?.get_wm_class()}), raising ${window?.get_wm_class() ?? 'nothing'}`);
                if (window)
                    Main.activateWindow(window);
                else
                    sourceApp(n.source)?.activate();
            }
            if (elapsed > FOCUS_TIMEOUT) {
                log(`gave up: focus stayed on ${global.display.focus_window?.get_wm_class()}`);
                return 'copied';
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
        }
        log(`focused ${global.display.focus_window?.get_wm_class()}`);
        await sleep(SETTLE_TIME);
        if (!this._windowMatches(global.display.focus_window, n)) {
            log('focus moved away before pasting');
            return 'copied';
        }
        // Keys must reach the window, not a shell widget.
        global.stage.set_key_focus(null);

        this._tap(Clutter.KEY_v, Clutter.KEY_Control_L);
        // Pasting is asynchronous in most toolkits; Enter too early sends
        // an empty message.
        await sleep(PASTE_TIME);
        this._tap(Clutter.KEY_Return);
        log('pasted and sent');

        await sleep(RESTORE_TIME);
        if (previous !== null)
            clipboard.set_text(St.ClipboardType.CLIPBOARD, previous);
        return 'sent';
    }

    destroy() {
        this._device?.run_dispose();
        this._device = null;
    }
}
