// In-row NDI preview receivers — Capture Console fork, Session 7 Part A.
// Runs in the console MAIN process (grandiose is N-API, proven there); frames go
// to the renderer over IPC and land in per-row canvases.
//
// Design constraints (verify-early results, 2026-08-19 — see fork CLAUDE.md S7):
// - BANDWIDTH_LOWEST + COLOR_FORMAT_RGBX_RGBA: 640x360 RGBA proxy, full content
//   rate offered, ~0.02 cores/receiver. RGBA goes straight into canvas ImageData.
// - Throttled pull returns CURRENT frames (NDI drops backlog receiver-side), so
//   the loop pulls at paint cadence (~3 fps) — decode cost only for painted frames.
// - receiver.video() throws on metadata/status frames — data() + filter by type.
// - Receivers have NO destroy(): NDIlib_recv_destroy runs via the GC finalizer.
//   Teardown = stop loop, let the in-flight data() settle, drop refs, force GC
//   (drop+gc verified to disconnect the same second; sender stops encoding).
// - LANDMINE: receive() on a hand-built name-only source SEGFAULTS grandiose
//   0.2.0 — receivers are ONLY created from finder-discovered Source objects.
// - A connected receiver makes the sender encode (Session 6: conn>0 ⇒ encode).
//   Preview-off must therefore really tear the receiver down, not stop painting.
'use strict';

const PULL_INTERVAL_MS = 333;   // ~3 fps: plenty for "right person / is it moving"
const DATA_TIMEOUT_MS = 1500;   // native NDIlib_recv_capture_v2 wait per pull
const QUIET_EXTRA_MS = 1000;    // slow the pull cadence while a source is quiet
const FIND_POLL_MS = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// grandiose 0.2.0 BUG (found 2026-08-19): when the native capture returns
// NDIlib_frame_type_none (its wait elapsed with no frame), dataReceiveComplete
// neither resolves nor rejects — receiver.data() HANGS FOREVER on a quiet
// source, freezing the pull loop (no errors, no heal, teardown never settles).
// Race it against a JS timeout: the native async work itself completes after
// its wait, so issuing the next pull is safe. Cost: grandiose leaks its small
// carrier + deferred per none-capture (console-only, restartable — tolerated;
// the quiet-cadence backoff keeps the rate low). Upstream-worthy fix.
function pullWithTimeout(receiver, waitMs) {
	return Promise.race([
		receiver.data(waitMs),
		new Promise((_, rej) => setTimeout(
			() => rej(Object.assign(new Error('no frame within wait'), { code: 'PULL_TIMEOUT' })),
			waitMs + 1000)),
	]);
}

class PreviewManager {
	// send(channel, payload) — deliver to the renderer (no-op safe when window gone)
	constructor(send, log) {
		this.send = send;
		this.log = log || (() => {});
		this.grandiose = null;
		this.unavailable = '';   // truthy = NDI receive not usable in this process
		this.finder = null;
		this.sources = [];       // last finder snapshot
		this.previews = new Map(); // player -> {player, ndiName, active, done, receiver, state, lastFrameAt}
		this.gcTimer = null;
		this.findTimer = null;
	}

	init() {
		try {
			this.grandiose = require('@stagetimerio/grandiose');
		} catch (err) {
			this.unavailable = `grandiose unavailable: ${err.message}`;
			this.log(`[prev] ${this.unavailable} — previews disabled`);
			return;
		}
		this.gcFn = this.resolveGc();
		this.startFinder().catch(err => {
			this.unavailable = `NDI find failed: ${err.message}`;
			this.log(`[prev] ${this.unavailable} — previews disabled`);
		});
	}

	// Forced GC is what makes preview-off actually disconnect (finalizer-driven
	// teardown). Prefer an exposed global.gc; else the new-context trick (the
	// flag applies to contexts created after it is set). Last resort: natural GC
	// (teardown still happens, just minutes later — log it honestly).
	resolveGc() {
		if (typeof global.gc === 'function') { this.log('[prev] gc: global.gc'); return global.gc; }
		try {
			require('v8').setFlagsFromString('--expose_gc');
			const gc = require('vm').runInNewContext('gc');
			if (typeof gc === 'function') { this.log('[prev] gc: vm new-context'); return gc; }
		} catch {}
		this.log('[prev] gc: NONE — preview-off disconnect will be lazy (natural GC)');
		return null;
	}

	async startFinder() {
		this.finder = await this.grandiose.find({ showLocalSources: true });
		const poll = async () => {
			if (!this.finder) return;
			try {
				await this.finder.wait(1000).catch(() => false);
				this.sources = this.finder.sources();
			} catch {}
			for (const p of this.previews.values()) {
				if (p.active && !p.receiver && !p.starting) this.attach(p);
			}
			this.findTimer = setTimeout(poll, FIND_POLL_MS);
		};
		poll();
	}

	// Full desired set: [{player, ndiName}] for rows that should have a LIVE
	// preview right now (global toggle && per-row toggle && row exists).
	// Reconciles receivers to it; everything else is torn down.
	sync(entries) {
		if (this.unavailable) return;
		const wanted = new Map(entries.map(e => [e.player, e]));
		for (const [player, p] of [...this.previews]) {
			const w = wanted.get(player);
			if (!w || w.ndiName !== p.ndiName) this.teardown(p);
		}
		for (const [player, e] of wanted) {
			const cur = this.previews.get(player);
			if (cur && cur.active) continue;
			const p = { player, ndiName: e.ndiName, active: true, done: false, starting: false, receiver: null, state: 'waiting', lastFrameAt: 0 };
			this.previews.set(player, p);
			this.attach(p);
		}
	}

	sourceFor(ndiName) {
		// advertised names are "<HOST> (<ndiName>)" — match the parenthesized tail
		return this.sources.find(s => s.name.endsWith(`(${ndiName})`)) || null;
	}

	async attach(p) {
		if (!p.active || p.receiver || p.starting) return;
		const source = this.sourceFor(p.ndiName);
		if (!source) { p.state = 'waiting'; return; } // finder poll retries
		p.starting = true;
		try {
			p.receiver = await this.grandiose.receive({
				source, // finder-discovered ONLY (name-only sources segfault the binding)
				colorFormat: this.grandiose.COLOR_FORMAT_RGBX_RGBA,
				bandwidth: this.grandiose.BANDWIDTH_LOWEST,
			});
		} catch (err) {
			this.log(`[prev] ${p.player}: receive() failed: ${err.message}`);
			p.starting = false;
			p.state = 'waiting';
			return;
		}
		p.starting = false;
		p.state = 'live';
		p.sourceUrl = source.urlAddress || '';
		p.attachedAt = Date.now();
		this.log(`[prev] ${p.player}: receiving ${source.name}${p.sourceUrl ? ` @ ${p.sourceUrl}` : ''}`);
		this.pullLoop(p);
	}

	async pullLoop(p) {
		p.pulls = 0; p.frames = 0; p.errs = 0;
		while (p.active && p.receiver) {
			const t0 = Date.now();
			p.pulls++;
			let quiet = false;
			try {
				const f = await pullWithTimeout(p.receiver, DATA_TIMEOUT_MS);
				if (f.type === 'video' && p.active) {
					p.frames++;
					p.lastFrameAt = Date.now();
					p.recycleDelayMs = 15000; // healthy stream resets the heal backoff
					// Buffer crosses IPC as a byte payload; renderer wraps it in ImageData.
					this.send('preview-frame', {
						player: p.player, xres: f.xres, yres: f.yres,
						stride: f.lineStrideBytes, data: f.data,
					});
				}
			} catch (err) {
				// quiet source (PULL_TIMEOUT) or transient error — keep pulling,
				// but never silently: a receiver that only ever errors looks
				// identical to a quiet sender without this.
				quiet = err.code === 'PULL_TIMEOUT';
				p.errs++;
				if (p.errs === 1 || p.errs % 40 === 0) {
					this.log(`[prev] ${p.player}: pull error #${p.errs} (${p.pulls} pulls, ${p.frames} frames): ${err.code || err.message || err}`);
				}
			}
			// Self-heal (observed 2026-08-19, twice): after a video-host restart a
			// receiver may keep its NDI connection yet never deliver another frame
			// — and recovery is a coin flip per receiver (2/6 resumed on one
			// reload). An address-change check does NOT catch it: re-created
			// senders reuse the same ports. So: recycle any receiver that has been
			// frameless for a while although its source is still advertised, with
			// per-preview backoff (15s→30s→60s cap, reset on any frame) so a
			// legitimately quiet source (parked/stopped sender — the badge case)
			// costs at most one cheap receiver re-create per minute.
			if (p.active && Date.now() - Math.max(p.lastFrameAt, p.attachedAt) > (p.recycleDelayMs || 15000)) {
				const cur = this.sourceFor(p.ndiName);
				if (cur) {
					p.recycleDelayMs = Math.min((p.recycleDelayMs || 15000) * 2, 60000);
					this.log(`[prev] ${p.player}: frameless ${Math.round((Date.now() - Math.max(p.lastFrameAt, p.attachedAt)) / 1000)}s while advertised — recycling receiver (next check ${p.recycleDelayMs / 1000}s)`);
					break;
				}
			}
			const spend = Date.now() - t0;
			// quiet sources pull slower: fewer leaked none-capture carriers (see
			// pullWithTimeout) and no busy-spin against a parked sender
			if (p.active) await sleep(Math.max(0, PULL_INTERVAL_MS + (quiet ? QUIET_EXTRA_MS : 0) - spend));
		}
		// in-flight capture has settled — the old receiver may be released to GC
		p.receiver = null;
		if (p.active) {
			// recycle path: still wanted; finder poll re-attaches from fresh discovery
			p.state = 'waiting';
			this.gcSoon();
			return;
		}
		p.done = true;
		this.gcSoon();
	}

	teardown(p) {
		if (!this.previews.delete(p.player)) return;
		p.active = false; // loop exits after the in-flight data() settles
		p.state = 'off';
		if (!p.receiver) { p.done = true; this.gcSoon(); }
		this.log(`[prev] ${p.player}: teardown`);
	}

	gcSoon() {
		if (!this.gcFn || this.gcTimer) return;
		this.gcTimer = setTimeout(() => {
			this.gcTimer = null;
			try { this.gcFn(); } catch {}
		}, 500);
	}

	// snapshot for the renderer's state poll
	states() {
		const out = {};
		for (const [player, p] of this.previews) out[player] = p.state;
		return out;
	}

	async shutdown() {
		clearTimeout(this.findTimer);
		for (const p of [...this.previews.values()]) this.teardown(p);
		if (this.finder) { try { await this.finder.destroy(); } catch {} this.finder = null; }
	}
}

module.exports = { PreviewManager, PULL_INTERVAL_MS };
