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

// Drawn behind the island, a little larger than it, following its geometry.
export const Aura = GObject.registerClass(
class Aura extends St.DrawingArea {
    constructor(island, spectrum, margin) {
        super({reactive: false, opacity: 0});
        this._island = island;
        this._spectrum = spectrum;
        this._margin = margin;
        this.mode = 'line';
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
        const s = this.scale;
        const levels = this._spectrum.levels;
        const [r, g, b] = this.color.map(c => c / 255);
        const iw = w - 2 * m, ih = h - 2 * m;
        if (iw <= 0 || ih <= 0) {
            cr.$dispose();
            return;
        }
        const radius = Math.min(this.radius, ih / 2, iw / 2);

        if (this.mode === 'bars') {
            this._drawSpectrum(cr, m, iw, ih, s, levels, [r, g, b]);
        } else {
            // A hairline around the pill that brightens with the beat.
            const bass = (levels[0] + levels[1] + levels[2]) / 3;
            const mid = levels.slice(3, 12).reduce((a, v) => a + v, 0) / 9;
            const target = Math.min(1, 0.7 * bass + 0.5 * mid);
            this._energy = (this._energy ?? 0) * 0.6 + target * 0.4;
            const e = this._energy;
            const inset = 0.5 * s;
            for (const [extra, alpha] of [[5, 0.05], [3, 0.09], [1.5, 0.16]]) {
                const grow = extra * s * e;
                roundedRect(cr, m - inset - grow, m - inset - grow,
                    iw + 2 * (inset + grow), ih + 2 * (inset + grow), radius + inset + grow);
                cr.setLineWidth(1.2 * s);
                cr.setSourceRGBA(r, g, b, alpha * e);
                cr.stroke();
            }
            roundedRect(cr, m - inset, m - inset, iw + 2 * inset, ih + 2 * inset, radius + inset);
            cr.setLineWidth((1 + 0.6 * e) * s);
            cr.setSourceRGBA(r, g, b, 0.12 + 0.6 * e);
            cr.stroke();
        }
        cr.$dispose();
    }

    // A slim, mirrored spectrum centred under the pill, fading at the ends.
    _drawSpectrum(cr, m, iw, ih, s, levels, [r, g, b]) {
        const count = 24;
        const barW = 2 * s, gap = 2.5 * s;
        const total = count * barW + (count - 1) * gap;
        const x0 = m + (iw - total) / 2;
        const top = m + ih + 3 * s;
        const maxH = m - 4 * s;
        cr.setLineCap(1); // ROUND
        cr.setLineWidth(barW);
        for (let i = 0; i < count; i++) {
            const fromCentre = Math.abs(i - (count - 1) / 2) / ((count - 1) / 2);
            const band = Math.round(fromCentre * 14);
            const v = Math.sqrt(Math.min(1, levels[band] ?? 0));
            const fade = 1 - fromCentre * 0.7;
            const x = x0 + i * (barW + gap) + barW / 2;
            const len = Math.max(0.5 * s, v * maxH);
            cr.moveTo(x, top);
            cr.lineTo(x, top + len);
            cr.setSourceRGBA(r, g, b, (0.25 + 0.65 * v) * fade);
            cr.stroke();
        }
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
