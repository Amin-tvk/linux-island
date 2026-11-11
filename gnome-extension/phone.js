// Phone integration through GSConnect (KDE Connect for GNOME). GSConnect
// posts phone events as GNOME notifications; their ids and default actions
// tell us what they are, independent of the language:
//   'ringing|<caller>'          incoming call (button: Mute)
//   'talking|<caller>'          ongoing call
//   '<id>|<uuid>' + action 'replyNotification'   repliable phone message
//   action 'replySms'           SMS (opens GSConnect's messaging window)
// Replies to repliable messages are sent through the phone itself.

import GLib from 'gi://GLib';

const GSCONNECT_APP = 'org.gnome.Shell.Extensions.GSConnect.desktop';

// GTK notification sources keep their app in _app, FDO ones in app.
export function sourceApp(source) {
    return source?.app ?? source?._app ?? null;
}

export function isPhoneNotification(n) {
    return sourceApp(n?.source)?.get_id?.() === GSCONNECT_APP;
}

// The (ssbv) target of GSConnect's 'app.device' action:
// [deviceId, actionName, hasParameter, parameter].
function deviceTarget(n) {
    if (n?._defaultAction !== 'app.device' || !n._defaultActionTarget)
        return null;
    try {
        const [deviceId, action, , parameter] = n._defaultActionTarget.deepUnpack();
        return {deviceId, action, parameter};
    } catch {
        return null;
    }
}

// 'call' | 'ongoing' | 'missed' | 'message' | 'sms' | 'phone' | null
export function phoneKind(n) {
    if (!isPhoneNotification(n))
        return null;
    const id = String(n.id ?? '');
    if (id.startsWith('ringing|'))
        return 'call';
    if (id.startsWith('talking|'))
        return 'ongoing';
    if (id.includes('MissedCall'))
        return 'missed';
    const target = deviceTarget(n);
    if (target?.action === 'replyNotification')
        return 'message';
    if (target?.action === 'replySms')
        return 'sms';
    return 'phone';
}

export function canReplyViaPhone(n) {
    return phoneKind(n) === 'message';
}

// Sends @text as the reply through the phone. Returns true if handed over.
export function replyViaPhone(n, text) {
    const target = deviceTarget(n);
    if (target?.action !== 'replyNotification' || !n.source?.activateAction)
        return false;
    // Same parameter GSConnect built, with the message filled in: with a
    // message it sends the reply instead of opening its reply dialog.
    const [uuid, , notification] = target.parameter.deepUnpack();
    const parameter = new GLib.Variant('(ssa{ss})', [uuid, text, notification]);
    n.source.activateAction('device',
        new GLib.Variant('(ssbv)', [target.deviceId, 'replyNotification', true, parameter]));
    return true;
}
