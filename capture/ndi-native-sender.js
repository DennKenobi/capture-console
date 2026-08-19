// Native NDI sender wrapper — Capture Console fork, Session 6.
// Same contract shape as ndi-sender.js, backed by native-modules/ndi-texture-send:
// the frame path (GPU map/copy + NDI submit + completion) runs on a native worker
// thread per sender, off the Electron main loop. Two frame entry points:
//   sendTexture(handleBuf, w, h, fmt) — Electron OSR shared-texture handle (GPU path)
//   sendFrame(bgra, w, h, stride)     — CPU buffer fallback (toBitmap pipeline)
//
// Create/park/name-linger semantics are identical to the JS wrapper: same retry
// ladder over the same lingering-name window, senders live for the process
// lifetime, destroy only at exit under the external watchdog (Session 5 wedge
// rules apply to native code too).
'use strict';

const nts = require('../native-modules/ndi-texture-send');

const CREATE_RETRY_MS = [0, 2000, 5000, 10000, 20000, 30000, 60000, 60000, 60000, 60000, 60000];

function available() { return nts.available; }
function loadError() { return nts.loadError; }
function probeOpen(handleBuffer) { return nts.probeOpen(handleBuffer); }

async function create(name, { fps = 30, depth = 2, onLog = console.log } = {}) {
	let sender = null;
	for (let attempt = 0; attempt < CREATE_RETRY_MS.length; attempt++) {
		if (CREATE_RETRY_MS[attempt] > 0) {
			onLog(`[ndi-native] sender name "${name}" busy; retrying in ${CREATE_RETRY_MS[attempt] / 1000}s (attempt ${attempt + 1})`);
			await new Promise(r => setTimeout(r, CREATE_RETRY_MS[attempt]));
		}
		try {
			sender = nts.createSender(name, fps, depth);
			break;
		} catch (err) {
			if (attempt === CREATE_RETRY_MS.length - 1) throw err;
		}
	}
	onLog(`[ndi-native] sender created: ${name} (fps=${fps} depth=${depth})`);

	return {
		native: true,
		/** GPU path: 1 = queued, 0 = dropped (pipeline full), -1 = open/copy failed. */
		sendTexture(handleBuf, width, height, pixelFormat) {
			return sender.sendTexture(handleBuf, width, height, pixelFormat || 'bgra');
		},
		/** CPU fallback path: same return codes. */
		sendFrame(bgra, width, height, strideBytes) {
			return sender.sendFrame(bgra, width, height, strideBytes || width * 4, 'bgra');
		},
		/** Comparable to ndi-sender.js stats(), plus the native-path extras. */
		stats() {
			const s = sender.stats();
			return {
				sent: s.sent, dropped: s.dropped, openFails: s.openFails,
				// lat= in the host log: NDI submit time (native worker, per frame)
				latencyMs: +s.sendMs.toFixed(1),
				// copy= analogue: GPU map wait (the readback cost the main loop no longer pays)
				mapMs: +s.mapMs.toFixed(1),
				inFlight: s.queued,
				lastError: s.lastError,
			};
		},
		connections() { return sender.connections(); },
		/** Downstream tally (Session 8): { changed, on_program, on_preview }. */
		tally() { return sender.tally(); },
		async drain(timeoutMs = 500) {
			const t0 = Date.now();
			while (sender.stats().queued > 0 && Date.now() - t0 < timeoutMs) {
				await new Promise(r => setTimeout(r, 25));
			}
			return sender.stats().queued === 0;
		},
		/** Exit path only — watchdog-guarded, never in a live host. */
		async destroy() { sender.destroy(); },
	};
}

module.exports = { create, available, loadError, probeOpen };
