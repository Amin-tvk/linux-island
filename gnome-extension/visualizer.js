// Audio-reactive visualizer: reads the spectrum of what the speakers play
// (the default sink's monitor) and draws it around the island.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const BANDS = 48;        // analysed bands; the top third is mostly silent
const USED_BANDS = 32;
const INTERVAL_NS = 33_000_000;
const FLOOR_DB = -70;

// Emits 'levels' with an array of USED_BANDS values in 0..1.
export class Spectrum extends EventEmitter {
    constructor() {
        super();
        this.levels = new Array(USED_BANDS).fill(0);
        this.available = true;
        this._pipeline = null;
        this._running = false;
    }

    async _create() {
        let Gst;
        try {
            ({default: Gst} = await import('gi://Gst?version=1.0'));
            Gst.init(null);
        } catch (e) {
            console.warn(`linux-island: GStreamer unavailable, no visualizer: ${e.message}`);
            this.available = false;
            return;
        }
        this._Gst = Gst;
        try {
            this._pipeline = Gst.parse_launch(
                'pulsesrc device=@DEFAULT_MONITOR@ client-name="Linux Island visualizer" ! ' +
                'audioconvert ! audio/x-raw,channels=1 ! ' +
                `spectrum bands=${BANDS} threshold=${FLOOR_DB} interval=${INTERVAL_NS} post-messages=true ! ` +
                'fakesink sync=false');
        } catch (e) {
            console.warn(`linux-island: visualizer pipeline failed (needs pulsesrc and spectrum): ${e.message}`);
            this.available = false;
            return;
        }
        const bus = this._pipeline.get_bus();
        bus.add_signal_watch();
        this._busId = bus.connect('message::element', (_b, msg) => this._onMessage(msg));
        this._errorId = bus.connect('message::error', (_b, msg) => {
            const [error] = msg.parse_error();
            console.warn(`linux-island: visualizer stopped: ${error.message}`);
            this.available = false;
            this.stop();
            this.emit('unavailable');
        });
    }

    _onMessage(msg) {
        const s = msg.get_structure();
        if (s?.get_name() !== 'spectrum')
            return;
        const [ok, magnitudes] = s.get_list('magnitude');
        if (!ok)
            return;
        for (let i = 0; i < USED_BANDS; i++) {
            const db = magnitudes.get_nth(i);
            let v = Math.max(0, (db - FLOOR_DB) / -FLOOR_DB);
            v = Math.pow(v, 1.6) * (1 + i / USED_BANDS); // lift the quieter highs
            // fast attack, slow release
            const prev = this.levels[i];
            this.levels[i] = v > prev ? v : prev * 0.82 + v * 0.18;
        }
        this.emit('levels', this.levels);
    }

    async start() {
        if (this._running)
            return;
        this._running = true;
        if (!this._pipeline && this.available)
            await this._create();
        if (this._running && this._pipeline)
            this._pipeline.set_state(this._Gst.State.PLAYING);
    }

    stop() {
        this._running = false;
        // NULL, not PAUSED: closes the recording stream.
        this._pipeline?.set_state(this._Gst.State.NULL);
        this.levels.fill(0);
        this.emit('levels', this.levels);
    }

    get running() {
        return this._running && !!this._pipeline && this.available;
    }

    destroy() {
        this.stop();
        if (this._pipeline) {
            const bus = this._pipeline.get_bus();
            bus.disconnect(this._busId);
            bus.disconnect(this._errorId);
            bus.remove_signal_watch();
        }
        this._pipeline = null;
        this.disconnectAll();
    }
}

// A point and its outward normal at distance @d along a rounded rect's
// outline, starting at the top centre and going clockwise.
function outlinePoint(x, y, w, h, r, d) {
    const straightW = w - 2 * r, straightH = h - 2 * r, arc = Math.PI * r / 2;
    const segs = [
        ['line', straightW / 2, [x + w / 2, y], [1, 0], [0, -1]],
        ['arc', arc, [x + w - r, y + r], -Math.PI / 2],
        ['line', straightH, [x + w, y + r], [0, 1], [1, 0]],
        ['arc', arc, [x + w - r, y + h - r], 0],
        ['line', straightW, [x + w - r, y + h], [-1, 0], [0, 1]],
        ['arc', arc, [x + r, y + h - r], Math.PI / 2],
        ['line', straightH, [x, y + h - r], [0, -1], [-1, 0]],
        ['arc', arc, [x + r, y + r], Math.PI],
        ['line', straightW / 2, [x + r, y], [1, 0], [0, -1]],
    ];
    for (const seg of segs) {
        const len = seg[1];
        if (d <= len || seg === segs[segs.length - 1]) {
            if (seg[0] === 'line') {
                const [[sx, sy], [dx, dy], normal] = [seg[2], seg[3], seg[4]];
                return [sx + dx * d, sy + dy * d, normal[0], normal[1]];
            }
            const [cx, cy] = seg[2];
            const a = seg[3] + (len > 0 ? d / r : 0);
            return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.cos(a), Math.sin(a)];
        }
        d -= len;
    }
    return [x, y, 0, -1];
}

// Drawn behind the island, a little larger than it, following its geometry.
export const Aura = GObject.registerClass(
class Aura extends St.DrawingArea {
    constructor(island, spectrum, margin) {
        super({reactive: false, opacity: 0});
        this._island = island;
        this._spectrum = spectrum;
        this._margin = margin;
        this.mode = 'bars';
        this.color = [255, 255, 255];
        this.radius = 18;
        this.scale = 1;
        this._posConstraint = new Clutter.BindConstraint({source: island, coordinate: Clutter.BindCoordinate.POSITION, offset: -margin});
        this._sizeConstraint = new Clutter.BindConstraint({source: island, coordinate: Clutter.BindCoordinate.SIZE, offset: 2 * margin});
        this.add_constraint(this._posConstraint);
        this.add_constraint(this._sizeConstraint);
        Main.layoutManager.uiGroup.insert_child_below(this, island);
        island.bind_property('visible', this, 'visible', GObject.BindingFlags.SYNC_CREATE);
        spectrum.connectObject('levels', () => this.queue_repaint(), this);
    }

    setMargin(margin) {
        this._margin = margin;
        this._posConstraint.offset = -margin;
        this._sizeConstraint.offset = 2 * margin;
    }

    set active(active) {
        this.ease({opacity: active ? 255 : 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const m = this._margin;
        const levels = this._spectrum.levels;
        const [r, g, b] = this.color.map(c => c / 255);
        const iw = w - 2 * m, ih = h - 2 * m;
        if (iw <= 0 || ih <= 0) {
            cr.$dispose();
            return;
        }
        const radius = Math.min(this.radius, ih / 2, iw / 2);

        if (this.mode === 'glow') {
            const bass = (levels[0] + levels[1] + levels[2] + levels[3]) / 4;
            const mid = levels.slice(4, 16).reduce((a, v) => a + v, 0) / 12;
            const steps = 10;
            for (let i = steps; i > 0; i--) {
                const grow = (i / steps) * m * Math.min(1, 0.35 + bass);
                roundedRect(cr, m - grow, m - grow, iw + 2 * grow, ih + 2 * grow, radius + grow);
                cr.setSourceRGBA(r, g, b, 0.05 * (0.4 + mid + bass));
                cr.fill();
            }
        } else {
            const perim = 2 * (iw - 2 * radius) + 2 * (ih - 2 * radius) + 2 * Math.PI * radius;
            const count = Math.max(24, Math.round(perim / (6.5 * this.scale)));
            const lineWidth = 3 * this.scale;
            cr.setLineCap(1); // ROUND
            cr.setLineWidth(lineWidth);
            for (let k = 0; k < count; k++) {
                // Mirror the spectrum so it is symmetric, bass at the bottom.
                const u = k / count;
                const fromBottom = Math.abs(u - 0.5) * 2; // 0 at bottom, 1 at top
                const band = Math.min(levels.length - 1, Math.floor(fromBottom * (levels.length - 1)));
                const v = Math.sqrt(Math.min(1, levels[band]));
                if (v < 0.08)
                    continue;
                const [px, py, nx, ny] = outlinePoint(m, m, iw, ih, radius, u * perim);
                const start = 2.5 * this.scale;
                const len = start + v * (m - start - lineWidth);
                cr.moveTo(px + nx * start, py + ny * start);
                cr.lineTo(px + nx * len, py + ny * len);
                cr.setSourceRGBA(r, g, b, 0.45 + 0.55 * v);
                cr.stroke();
            }
        }
        cr.$dispose();
    }
});

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}
