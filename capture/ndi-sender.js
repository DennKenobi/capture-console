// NDI Sender module — Capture Console fork.
// Contract per ARCHITECTURE.md §2: create(name) → { sendFrame, connections, destroy }.
// Video-only by design: no audio ever crosses NDI in this system.
//
// Sender names hard-fail creation while a duplicate is live, and linger for a
// window (~minutes) after their process exits — even after a clean destroy().
// OBS scenes bind to the name, so we retry with backoff instead of renaming.

const grandiose = require('@stagetimerio/grandiose');

const CREATE_RETRY_MS = [0, 2000, 5000, 10000, 20000, 30000, 60000];

async function create(name, { fps = 30, onLog = console.log } = {}) {
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

	// Depth-2 send pipeline: one frame on the NDI thread while the next is submitted.
	// Depth 1 caps a 60fps stream at ~44fps (measured 2026-08-18); deeper than 2 just adds
	// latency. Frames beyond the cap are dropped, never queued.
	const MAX_IN_FLIGHT = 2;
	let inFlight = 0;
	let dropped = 0;
	let sent = 0;

	return {
		/** BGRA buffer → NDI frame. Returns false if dropped (pipeline full). */
		sendFrame(bgra, width, height, strideBytes) {
			if (inFlight >= MAX_IN_FLIGHT) { dropped++; return false; }
			inFlight++;
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
			}).then(() => { sent++; inFlight--; })
				.catch(err => { inFlight--; onLog(`[ndi] send error: ${err.message}`); });
			return true;
		},
		stats() { return { sent, dropped }; },
		connections() { return sender.connections ? sender.connections() : -1; },
		tally() { return sender.tally; },
		async destroy() { if (sender && sender.destroy) await sender.destroy(); sender = null; },
	};
}

module.exports = { create };
