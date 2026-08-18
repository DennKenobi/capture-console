// NDI Sender module — Capture Console fork.
// Contract per ARCHITECTURE.md §2: create(name) → { sendFrame, connections, destroy }.
// Video-only by design: no audio ever crosses NDI in this system.
//
// Sender names hard-fail creation while a duplicate is live, and linger for a
// window (~minutes) after their process exits — even after a clean destroy().
// OBS scenes bind to the name, so we retry with backoff instead of renaming.

const grandiose = require('@stagetimerio/grandiose');

// Ladder must outlast the observed post-kill advertisement linger (~4 min after an
// unclean exit, Session 2 + Session 5 measurements): total ≈ 6.1 min.
const CREATE_RETRY_MS = [0, 2000, 5000, 10000, 20000, 30000, 60000, 60000, 60000, 60000, 60000];

async function create(name, { fps = 30, depth = 2, onLog = console.log } = {}) {
	let sender = null;
	for (let attempt = 0; attempt < CREATE_RETRY_MS.length; attempt++) {
		if (CREATE_RETRY_MS[attempt] > 0) {
			onLog(`[ndi] sender name "${name}" busy; retrying in ${CREATE_RETRY_MS[attempt] / 1000}s (attempt ${attempt + 1})`);
			await new Promise(r => setTimeout(r, CREATE_RETRY_MS[attempt]));
		}
		try {
			// clockVideo:false — paint events set the cadence, NDI must not throttle us.
			sender = await grandiose.send({ name, clockVideo: false, clockAudio: false });
			break;
		} catch (err) {
			if (attempt === CREATE_RETRY_MS.length - 1) throw err;
		}
	}
	onLog(`[ndi] sender created: ${typeof sender.sourcename === 'function' ? sender.sourcename() : name}`);

	// Bounded send pipeline: up to `depth` frames in flight; beyond that frames are
	// dropped, never queued. Depth 1 caps a 60fps stream at ~44fps (measured 2026-08-18).
	// Depth 2 suits one sender per process. In a consolidated multi-sender process the
	// send-completion callbacks share a busy main loop and come back late, so a deeper
	// pipeline (4-6) is needed to absorb the completion latency (measured 2026-08-18:
	// six senders at depth 2 starve to ~10 fps each while pure Node does 6x30 clean).
	const MAX_IN_FLIGHT = depth;
	let inFlight = 0;
	let dropped = 0;
	let sent = 0;
	let latencyEmaMs = 0; // send-submit -> completion-callback, smoothed
	return {
		/** BGRA buffer → NDI frame. Returns false if dropped (pipeline full). */
		sendFrame(bgra, width, height, strideBytes) {
			if (inFlight >= MAX_IN_FLIGHT) { dropped++; return false; }
			inFlight++;
			const t0 = Date.now();
			sender.video({
				xres: width,
				yres: height,
				frameRateN: fps,
				frameRateD: 1,
				fourCC: grandiose.FOURCC_BGRA,
				pictureAspectRatio: width / height,
				frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
				lineStrideBytes: strideBytes || width * 4,
				data: bgra,
			}).then(() => {
				sent++; inFlight--;
				latencyEmaMs = latencyEmaMs ? latencyEmaMs * 0.9 + (Date.now() - t0) * 0.1 : Date.now() - t0;
			}).catch(err => { inFlight--; onLog(`[ndi] send error: ${err.message}`); });
			return true;
		},
		stats() { return { sent, dropped, latencyMs: +latencyEmaMs.toFixed(1) }; },
		connections() { return sender.connections ? sender.connections() : -1; },
		tally() { return sender.tally; },
		async destroy() { if (sender && sender.destroy) await sender.destroy(); sender = null; },
	};
}

module.exports = { create };
