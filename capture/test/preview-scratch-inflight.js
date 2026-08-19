// Session 7 verify-early: isolate the phase-4 segfault from preview-scratch-recv.
// ISOLATION RESULT (2026-08-19): step A — grandiose.receive() on a hand-built
// name-only source (no urlAddress) — SEGFAULTS grandiose 0.2.0 before returning.
// GC with a capture in flight on a real source (step D) SURVIVES. Rule encoded in
// console-previews: receivers are only created from finder-discovered Sources.
// Step A is kept behind --bogus (it WILL crash the process — that is the point).
//   node --expose-gc capture/test/preview-scratch-inflight.js [--name=CC-S7-SCRATCH] [--bogus]
'use strict';
const grandiose = require('@stagetimerio/grandiose');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const NAME = arg('name', 'CC-S7-SCRATCH');

async function main() {
	if (process.argv.includes('--bogus')) {
		// step A: receive() on a name-only bogus source (no urlAddress) — SEGFAULTS
		console.log('[A] receive(bogus name-only source)… (expect segfault)');
		let rBogus = await grandiose.receive({
			source: { name: 'NOSUCHHOST (CC-S7-BOGUS)' },
			colorFormat: grandiose.COLOR_FORMAT_RGBX_RGBA,
			bandwidth: grandiose.BANDWIDTH_LOWEST,
		});
		console.log('[A] receive() returned ok (crash class fixed upstream?)');
		rBogus = null;
		global.gc();
	}

	// step D: the dangerous-looking case — gc while data() is in flight, on a REAL source
	console.log('[D] receive(real source)…');
	const finder = await grandiose.find({ showLocalSources: true });
	let source = null;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline && !source) {
		await finder.wait(2000).catch(() => false);
		source = finder.sources().find(s => s.name.includes(NAME));
	}
	await finder.destroy();
	if (!source) { console.log('[D] SKIP: no live source'); process.exit(0); }
	let rLive = await grandiose.receive({ source, colorFormat: grandiose.COLOR_FORMAT_RGBX_RGBA, bandwidth: grandiose.BANDWIDTH_LOWEST });
	console.log('[D] starting data(5000), then dropping ref + gc while in flight…');
	const inflight = rLive.data(5000).then(f => `resolved:${f.type}`, e => `rejected:${e.code || e.message}`);
	rLive = null;
	global.gc();
	console.log('[D] gc issued; awaiting in-flight settle…');
	console.log(`[D] settled without crash: ${await inflight}`);
	global.gc();
	await sleep(1000);
	console.log('[E] ALL DONE — no crash');
	process.exit(0);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
