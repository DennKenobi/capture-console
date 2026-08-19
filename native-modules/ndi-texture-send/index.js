// Graceful loader for the ndi-texture-send native module (same pattern as
// electron-asio): a missing/unbuilt binary must degrade to the CPU pipeline,
// never crash the host.
'use strict';

let native = null;
let loadError = null;
try {
	native = require('./build/Release/ndi_texture_send.node');
} catch (err) {
	loadError = err;
}

module.exports = {
	available: !!native,
	loadError,
	/** Verify-early step 1: open one real paint-event handle, return its desc. */
	probeOpen(handleBuffer) {
		if (!native) throw loadError;
		return native.probeOpen(handleBuffer);
	},
	/** createSender(name, fps, depth) — throws while the NDI name is busy/lingering. */
	createSender(name, fps, depth) {
		if (!native) throw loadError;
		return native.createSender(name, fps, depth);
	},
};
