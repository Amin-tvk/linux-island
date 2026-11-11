// MPRIS watcher: tracks every org.mpris.MediaPlayer2.* player on the session
// bus and picks the one the island should show.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

// playerctld re-exports other players; showing it would duplicate them.
const IGNORED_PLAYERS = ['org.mpris.MediaPlayer2.playerctld'];

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek"><arg direction="in" type="x" name="Offset"/></method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
  </interface>
</node>`);

const RootProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
  </interface>
</node>`);

const TRACKLIST_IFACE = 'org.mpris.MediaPlayer2.TrackList';
const PLAYLISTS_IFACE = 'org.mpris.MediaPlayer2.Playlists';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

function asString(v) {
    if (Array.isArray(v))
        return v.filter(s => typeof s === 'string').join(', ');
    return typeof v === 'string' ? v : '';
}

export class Player extends EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        this.status = 'Stopped';
        this.title = '';
        this.artist = '';
        this.album = '';
        this.artUrl = '';
        this.trackId = '';
        this.length = 0; // microseconds
        this.canNext = false;
        this.canPrev = false;
        this.canSeek = false;
        this.identity = '';
        this.desktopEntry = '';
        this.lastActive = 0;
        this.hasTrackList = false;
        this.hasPlaylists = false;

        this._position = 0;
        this._positionTime = 0;
        this._cancellable = new Gio.Cancellable();

        this._root = new RootProxy(Gio.DBus.session, busName, MPRIS_PATH,
            (proxy, error) => {
                if (error)
                    return;
                this.identity = proxy.Identity ?? '';
                this.desktopEntry = proxy.DesktopEntry ?? '';
                this.hasTrackList = !!proxy.HasTrackList;
                this.emit('changed');
                this._probePlaylists();
            }, this._cancellable);

        this._proxy = new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH,
            (proxy, error) => {
                if (error) {
                    console.debug(`linux-island: ${busName}: ${error.message}`);
                    return;
                }
                this._propsId = proxy.connect('g-properties-changed',
                    () => this._sync());
                this._seekedId = proxy.connectSignal('Seeked',
                    (_p, _s, [pos]) => this._setPosition(pos));
                this._sync();
                this.refreshPosition();
            }, this._cancellable);
    }

    _sync() {
        const p = this._proxy;
        const oldTrack = this.trackId + this.title;
        const status = p.PlaybackStatus ?? 'Stopped';
        const wasPlaying = this.status === 'Playing';
        if (status !== this.status) {
            // Freeze the interpolated position at the moment of change.
            this._position = this.position;
            this._positionTime = GLib.get_monotonic_time();
        }
        this.status = status;

        const meta = p.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        this.title = asString(meta['xesam:title']);
        this.artist = asString(meta['xesam:artist']);
        this.album = asString(meta['xesam:album']);
        this.artUrl = asString(meta['mpris:artUrl']);
        this.trackId = asString(meta['mpris:trackid']);
        this.length = Number(meta['mpris:length'] ?? 0);
        this.canNext = !!p.CanGoNext;
        this.canPrev = !!p.CanGoPrevious;
        this.canSeek = !!p.CanSeek && this.length > 0;

        const trackChanged = oldTrack !== this.trackId + this.title;
        if (this.status === 'Playing' && (!wasPlaying || trackChanged))
            this.lastActive = GLib.get_monotonic_time();
        if (trackChanged)
            this.refreshPosition();
        this.emit('changed');
    }

    _setPosition(pos) {
        this._position = Number(pos);
        this._positionTime = GLib.get_monotonic_time();
        this.emit('position');
    }

    // Interpolated position in microseconds.
    get position() {
        let pos = this._position;
        if (this.status === 'Playing' && this._positionTime)
            pos += GLib.get_monotonic_time() - this._positionTime;
        return this.length > 0 ? Math.min(pos, this.length) : pos;
    }

    // Position is not announced through PropertiesChanged, so ask for it.
    refreshPosition() {
        Gio.DBus.session.call(this.busName, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            null, Gio.DBusCallFlags.NONE, 1000, this._cancellable,
            (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    this._setPosition(v.deepUnpack());
                } catch {
                    // Player has no Position or went away.
                }
            });
    }

    get valid() {
        return this.title !== '' && this.status !== 'Stopped';
    }

    playPause() {
        this._proxy.PlayPauseRemote(() => {});
    }

    next() {
        this._proxy.NextRemote(() => {});
    }

    previous() {
        this._proxy.PreviousRemote(() => {});
    }

    seekTo(fraction) {
        if (!this.canSeek)
            return;
        const target = Math.round(Math.max(0, Math.min(1, fraction)) * this.length);
        if (this.trackId.startsWith('/') && this.trackId !== '/org/mpris/MediaPlayer2/TrackList/NoTrack')
            this._proxy.SetPositionRemote(this.trackId, target, () => {});
        else
            this._proxy.SeekRemote(target - this.position, () => {});
        this._setPosition(target);
    }

    raise() {
        this._root?.RaiseRemote(() => {});
    }

    _call(iface, method, params, replyType = null) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(this.busName, MPRIS_PATH, iface, method, params,
                replyType ? new GLib.VariantType(replyType) : null,
                Gio.DBusCallFlags.NONE, 2000, this._cancellable, (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _probePlaylists() {
        try {
            const v = await this._call('org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYLISTS_IFACE, 'PlaylistCount']));
            this.hasPlaylists = v.deepUnpack()[0].deepUnpack() > 0;
        } catch {
            this.hasPlaylists = false;
        }
        this.emit('changed');
    }

    // Up next: [{id, title, artist, artUrl, current}], or [] if unsupported.
    async getQueue() {
        if (!this.hasTrackList)
            return [];
        const tracks = await this._call('org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [TRACKLIST_IFACE, 'Tracks']));
        const ids = tracks.deepUnpack()[0].deepUnpack().slice(0, 100);
        if (ids.length === 0)
            return [];
        const res = await this._call(TRACKLIST_IFACE, 'GetTracksMetadata',
            new GLib.Variant('(ao)', [ids]));
        return res.recursiveUnpack()[0].map(m => ({
            id: asString(m['mpris:trackid']),
            title: asString(m['xesam:title']) || asString(m['xesam:url']).split('/').pop(),
            artist: asString(m['xesam:artist']),
            current: asString(m['mpris:trackid']) === this.trackId,
        })).filter(t => t.id && t.id !== NO_TRACK);
    }

    goTo(trackId) {
        this._call(TRACKLIST_IFACE, 'GoTo', new GLib.Variant('(o)', [trackId])).catch(() => {});
    }

    // [{id, name, active}], or [] if unsupported.
    async getPlaylists() {
        if (!this.hasPlaylists)
            return [];
        const res = await this._call(PLAYLISTS_IFACE, 'GetPlaylists',
            new GLib.Variant('(uusb)', [0, 50, 'UserDefined', false]));
        let active = null;
        try {
            const v = await this._call('org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYLISTS_IFACE, 'ActivePlaylist']));
            const [valid, [id]] = v.deepUnpack()[0].deepUnpack();
            active = valid ? id : null;
        } catch {
            // optional property
        }
        return res.deepUnpack()[0].map(([id, name]) => ({id, name, active: id === active}));
    }

    activatePlaylist(id) {
        this._call(PLAYLISTS_IFACE, 'ActivatePlaylist', new GLib.Variant('(o)', [id])).catch(() => {});
    }

    destroy() {
        this._cancellable.cancel();
        if (this._propsId)
            this._proxy.disconnect(this._propsId);
        if (this._seekedId)
            this._proxy.disconnectSignal(this._seekedId);
        this.disconnectAll();
    }
}

export class MprisWatcher extends EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._pinned = null;
        this._pinnedAt = 0;
        this.active = null;

        const bus = Gio.DBus.session;
        this._subId = bus.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX))
                        .forEach(n => this._addPlayer(n));
                } catch (e) {
                    console.error(`linux-island: ListNames failed: ${e.message}`);
                }
            });
    }

    get players() {
        return [...this._players.values()].filter(p => p.valid);
    }

    _addPlayer(name) {
        if (this._players.has(name) || IGNORED_PLAYERS.includes(name))
            return;
        const player = new Player(name);
        player.connect('changed', () => this._update());
        player.connect('position', () => {
            if (player === this.active)
                this.emit('position');
        });
        this._players.set(name, player);
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        if (this._pinned === player)
            this._pinned = null;
        player.destroy();
        this._update();
    }

    // Show the player the user picked, else the one that played most recently.
    _update() {
        const players = this.players;
        let active = null;
        if (this._pinned && players.includes(this._pinned))
            active = this._pinned;
        else
            active = players.sort((a, b) => b.lastActive - a.lastActive)[0] ?? null;

        // A player that starts playing after the pick takes over.
        const started = players.filter(p =>
            p.status === 'Playing' && p.lastActive > this._pinnedAt);
        if (active?.status !== 'Playing' && started.length > 0) {
            active = started.sort((a, b) => b.lastActive - a.lastActive)[0];
            this._pinned = null;
        }

        this.active = active;
        this.emit('changed');
    }

    cycle() {
        const players = this.players;
        if (players.length < 2)
            return;
        const i = players.indexOf(this.active);
        this._pinned = players[(i + 1) % players.length];
        this._pinnedAt = GLib.get_monotonic_time();
        this._update();
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._subId);
        for (const p of this._players.values())
            p.destroy();
        this._players.clear();
        this.disconnectAll();
    }
}
