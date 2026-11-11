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

// Without KDE Connect's telephony permission (or on phones that don't
// send call events) a call still arrives as a mirror of the phone's
// in-call notification. Android notification keys contain the package.
const DIALER = /incallui|dialer|telecom|com\.android\.phone/i;
const RINGING = /incoming|ringing|calling|تماس ورودی|درحال تماس|در حال تماس|زنگ/i;

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
    if (DIALER.test(id)) {
        if (n.actions.some(a => /call back|message|تماس مجدد|پیام/i.test(a.label)))
            return 'missed';
        return RINGING.test(`${n.title} ${n.body}`) ? 'call' : 'ongoing';
    }
    const target = deviceTarget(n);
    if (target?.action === 'replyNotification')
        return 'message';
    if (target?.action === 'replySms')
        return 'sms';
    return 'phone';
}

// Caller and status line. Mirrored notifications come as
// title = app name, body = "Caller: text".
export function callInfo(n) {
    const body = (n.body ?? '').trim();
    const sep = body.indexOf(': ');
    if (DIALER.test(String(n.id ?? '')) && sep > 0)
        return {name: body.slice(0, sep), text: body.slice(sep + 2)};
    return {name: n.title ?? '', text: body};
}

// For logs: the notification key without numbers or personal parts.
export function idShape(n) {
    return String(n?.id ?? '').split('|').map(p => /^[a-z][\w.]+$/i.test(p) ? p : p.replace(/./g, '#').slice(0, 3)).join('|');
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
