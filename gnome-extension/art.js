// Cover art: resolves an MPRIS artUrl to a local file (downloading http(s)
// covers into the cache) and finds an accent colour for it.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'linux-island']);
const MAX_CACHE_FILES = 60;

export const DEFAULT_ACCENT = [235, 235, 245];

export class ArtLoader {
    constructor() {
        this._session = new Soup.Session({timeout: 10});
        this._cancellable = new Gio.Cancellable();
        this._colors = new Map();
        GLib.mkdir_with_parents(CACHE_DIR, 0o700);
        this._pruneCache();
    }

    // Returns {path, color} or null.
    async load(url) {
        if (!url)
            return null;
        let path = null;
        if (url.startsWith('file://'))
            path = Gio.File.new_for_uri(url).get_path();
        else if (url.startsWith('/'))
            path = url;
        else if (url.startsWith('http://') || url.startsWith('https://'))
            path = await this._download(url);

        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
            return null;
        return {path, color: this._accent(path)};
    }

    async _download(url) {
        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const path = GLib.build_filenamev([CACHE_DIR, name]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
        try {
            const msg = Soup.Message.new('GET', url);
            const bytes = await new Promise((resolve, reject) => {
                this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT,
                    this._cancellable, (s, res) => {
                        try {
                            resolve(s.send_and_read_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            if (msg.get_status() !== Soup.Status.OK)
                return null;
            GLib.file_set_contents(path, bytes.toArray());
            return path;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`linux-island: cover download failed: ${e.message}`);
            return null;
        }
    }

    // Average of the image weighted towards saturated pixels, then pushed to
    // a bright, readable colour on black.
    _accent(path) {
        if (this._colors.has(path))
            return this._colors.get(path);
        let color = DEFAULT_ACCENT;
        try {
            const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 24, 24, false);
            const px = pb.read_pixel_bytes().toArray();
            const n = pb.get_n_channels(), stride = pb.get_rowstride();
            let r = 0, g = 0, b = 0, wsum = 0;
            for (let y = 0; y < pb.get_height(); y++) {
                for (let x = 0; x < pb.get_width(); x++) {
                    const i = y * stride + x * n;
                    const [pr, pg, pbl] = [px[i], px[i + 1], px[i + 2]];
                    const max = Math.max(pr, pg, pbl), min = Math.min(pr, pg, pbl);
                    const sat = max === 0 ? 0 : (max - min) / max;
                    const w = 0.05 + sat * sat * (max / 255);
                    r += pr * w;
                    g += pg * w;
                    b += pbl * w;
                    wsum += w;
                }
            }
            color = brighten([r / wsum, g / wsum, b / wsum]);
        } catch (e) {
            console.debug(`linux-island: could not read cover: ${e.message}`);
        }
        this._colors.set(path, color);
        return color;
    }

    _pruneCache() {
        try {
            const dir = Gio.File.new_for_path(CACHE_DIR);
            const files = [];
            const en = dir.enumerate_children('standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)))
                files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
            files.sort((a, b) => b[1] - a[1]);
            for (const [name] of files.slice(MAX_CACHE_FILES))
                dir.get_child(name).delete(null);
        } catch {
            // Cache is optional.
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }
}

function brighten([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    let l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r)
            h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h /= 6;
    }
    if (s < 0.12)
        return DEFAULT_ACCENT; // greyscale cover: stay neutral
    s = Math.min(1, Math.max(s, 0.55));
    l = Math.min(0.75, Math.max(l, 0.62));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = t => {
        t = (t + 1) % 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(v => Math.round(v * 255));
}
