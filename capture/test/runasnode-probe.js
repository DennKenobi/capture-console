// Session 11 verify-early step 5: MEASURE the ELECTRON_RUN_AS_NODE + asar
// interaction instead of assuming it. Run the packaged exe as plain Node against
// this script twice — once via the app.asar path, once via app.asar.unpacked —
// and compare:
//
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & ECANDI.exe <resources>\app.asar\capture\test\runasnode-probe.js
//   & ECANDI.exe <resources>\app.asar.unpacked\capture\test\runasnode-probe.js
//
// Prints one JSON line: where it ran from, whether a relative require into
// capture/ works there (url-builder is what supervisor.js actually needs), and
// the runtime identity (the 43.3.0-qp20 landmine check rides along for free).
'use strict';

const out = {
	probe: 'runasnode',
	dirname: __dirname,
	electron: process.versions.electron || null,
	node: process.versions.node,
	execPath: process.execPath,
	requireUrlBuilder: null,
};
try {
	const builder = require('../url-builder');
	out.requireUrlBuilder = typeof builder.validateConfig === 'function' ? 'ok' : 'loaded-but-wrong-shape';
} catch (err) {
	out.requireUrlBuilder = `FAIL: ${err.message}`;
}
console.log(JSON.stringify(out));
