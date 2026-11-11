// Phone integration through GSConnect (KDE Connect for GNOME). GSConnect
// posts phone events as GNOME notifications; their ids and default actions
// tell us what they are, independent of the language:
//   '<deviceId>|ringing|<caller>'   incoming call (button: Mute)
//   '<deviceId>|talking|<caller>'   ongoing call
//   '<id>|<uuid>' + action 'replyNotification'   repliable phone message
//   action 'replySms'           SMS (opens GSConnect's messaging window)
// Replies to repliable messages are sent through the phone itself.

import GLib from 'gi://GLib';

const GSCONNECT_APP = 'org.gnome.Shell.Extensions.GSConnect.desktop';

// Without KDE Connect's telephony permission (or on phones that don't
// send call events) a call still arrives as a mirror of the phone's
// in-call notification. Android notification keys contain the package.
const DIALER = /incallui|dialer|telecom|com\.android\.phone|com\.miui\.phone|com\.android\.server\.telecom|com\.google\.android\.dialer/i;
const RINGING = /incoming|ringing|calling|تماس ورودی|درحال تماس|در حال تماس|زنگ/i;
const ONGOING = /ongoing call|in call|تماس جاری|در حال مکالمه|مکالمه/i;
const MUTE_ACTION = /^mute$|ساکت|بی‌صدا|بی صدا/i;
const ANSWER_ACTION = /answer|decline|reject|accept|پاسخ|رد کردن|قطع/i;

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

function hasMuteAction(n) {
    return (n?.actions ?? []).some(a =>
        a.name === 'muteCall' ||
        String(a.name ?? '').endsWith('.muteCall') ||
        MUTE_ACTION.test(a.label ?? ''));
}

// GSConnect send_notification id is `${deviceId}|${params.id}`, so telephony
// ids look like `9b6b…|ringing|Alice`, not bare `ringing|Alice`.
function idHasEvent(id, event) {
    return id === event || id.startsWith(`${event}|`) || id.includes(`|${event}|`);
}

// 'call' | 'ongoing' | 'missed' | 'message' | 'sms' | 'phone' | null
export function phoneKind(n) {
    if (!isPhoneNotification(n))
        return null;
    const id = String(n.id ?? '');
    const text = `${n.title ?? ''} ${n.body ?? ''}`;

    if (idHasEvent(id, 'ringing'))
        return 'call';
    if (idHasEvent(id, 'talking'))
        return 'ongoing';
    // GSConnect telephony always attaches a Mute button while ringing.
    if (hasMuteAction(n))
        return 'call';
    if (id.includes('MissedCall') || /missed call|تماس از دست/i.test(text))
        return 'missed';
    if (DIALER.test(id)) {
        if (n.actions.some(a => /call back|message|تماس مجدد|پیام/i.test(a.label)))
            return 'missed';
        if (RINGING.test(text) || n.actions.some(a => ANSWER_ACTION.test(a.label)))
            return 'call';
        return 'ongoing';
    }
    // Telephony plugin body when the id format is unexpected.
    if (RINGING.test(n.body ?? '') || /^incoming call$/i.test((n.body ?? '').trim()))
        return 'call';
    if (ONGOING.test(n.body ?? '') || /^ongoing call$/i.test((n.body ?? '').trim()))
        return 'ongoing';

    const target = deviceTarget(n);
    if (target?.action === 'replyNotification')
        return 'message';
    if (target?.action === 'replySms')
        return 'sms';
    return 'phone';
}

// Generic mirrored app alerts (YouTube, Reddit…) — not calls/SMS/messages.
export function isGenericPhoneMirror(n) {
    return phoneKind(n) === 'phone';
}

// Caller and status line. Mirrored notifications come as
// title = app name, body = "Caller: text". Telephony uses title = caller.
export function callInfo(n) {
    const body = (n.body ?? '').trim();
    const sep = body.indexOf(': ');
    if (DIALER.test(String(n.id ?? '')) && sep > 0)
        return {name: body.slice(0, sep), text: body.slice(sep + 2)};
    // deviceId|ringing|Caller  or  ringing|Caller
    const id = String(n.id ?? '');
    const m = /(?:^|\|)(?:ringing|talking)\|(.+)$/.exec(id);
    if (m?.[1])
        return {name: m[1], text: body};
    return {name: n.title ?? '', text: body};
}

// For logs: the notification key without numbers or personal parts.
export function idShape(n) {
    return String(n?.id ?? '').split('|').map(p =>
        /^(ringing|talking|MissedCall)$/i.test(p) || /^[a-z][\w.]+$/i.test(p)
            ? p
            : p.replace(/./g, '#').slice(0, 3)
    ).join('|');
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
