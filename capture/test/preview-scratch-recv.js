// Session 7 verify-early step 1: scratch low-bandwidth NDI receive — pure Node.
// Answers, against one live sender, everything the in-console preview design
// depends on BEFORE any console code is written:
//   1. proxy geometry/fps/fourCC at BANDWIDTH_LOWEST with COLOR_FORMAT_RGBX_RGBA
//      (canvas ImageData wants RGBA; alpha-carrying BGRA input should yield RGBA)
//   2. metadata/status frames really do arrive on data() (filter by type)
//   3. throttled pull freshness: pulling at ~3 fps — are frames current (NDI
//      drops backlog) or stale (queue grows)? Decides pull-loop shape.
//   4. one receiver's CPU at full-rate and throttled pull
//   5. teardown: grandiose Receivers have NO destroy() — NDIlib_recv_destroy runs
//      only via the GC finalizer on receiver.embedded. Test drop-refs + forced GC:
//      does the sender's connections() drop? does a reconnect work? does GC with
//      a capture in flight crash the process (defines lifecycle discipline)?
//
//   node --expose-gc capture/test/preview-scratch-recv.js [--name=CC-S7-SCRATCH]
'use strict';
const grandiose = require('@stagetimerio/grandiose');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const NAME = arg('name', 'CC-S7-SCRATCH');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tsMs = ts => ts[0] * 1000 + ts[1] / 1e6; // PTP [s?, frac?] — treat pairwise deltas only

if (typeof global.gc !== 'function') {
	console.error('run with node --expose-gc');
	process.exit(1);
}

async function findSource(frag) {
	const finder = await grandiose.find({ showLocalSources: true });
	let source = null;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline && !source) {
		await finder.wait(2000).catch(() => false);
		source = finder.sources().find(s => s.name.includes(frag));
	}
	await finder.destroy();
	if (!source) throw new Error(`source containing "${frag}" not found within 20s`);
	return source;
}

function cpuWindowStart() { return { cpu: process.cpuUsage(), t: Date.now() }; }
function cpuWindowCores(w) {
	const cpu = process.cpuUsage(), t = Date.now();
	return ((cpu.user - w.cpu.user) + (cpu.system - w.cpu.system)) / ((t - w.t) * 1000);
}

async function main() {
	const source = await findSource(NAME);
	console.log(`[recv] source: ${source.name}`);

	// ---- phase 1: full-rate pull, 6 s ------------------------------------
	let receiver = await grandiose.receive({
		source,
		colorFormat: grandiose.COLOR_FORMAT_RGBX_RGBA,
		bandwidth: grandiose.BANDWIDTH_LOWEST,
	});
	const types = {}; let geometry = null, fourCC = null, frames = 0, tFirst = 0, tLast = 0;
	let cw = cpuWindowStart();
	const p1End = Date.now() + 6000;
	while (Date.now() < p1End) {
		let f;
		try { f = await receiver.data(2000); } catch (err) { types['error:' + (err.code || err.message)] = (types['error:' + (err.code || err.message)] || 0) + 1; continue; }
		types[f.type] = (types[f.type] || 0) + 1;
		if (f.type !== 'video') continue;
		if (!frames) { tFirst = Date.now(); geometry = { xres: f.xres, yres: f.yres, stride: f.lineStrideBytes }; fourCC = f.fourCC; }
		tLast = Date.now();
		frames++;
	}
	const cores1 = cpuWindowCores(cw);
	const fps1 = frames > 1 ? (frames - 1) / ((tLast - tFirst) / 1000) : 0;
	const ccName = Object.entries(grandiose).find(([k, v]) => k.startsWith('FOURCC_') && v === fourCC);
	console.log(`[recv] PHASE1 full-rate: ${JSON.stringify({ geometry, fourCC: ccName ? ccName[0] : fourCC, fps: +fps1.toFixed(2), types, recvCores: +cores1.toFixed(3) })}`);

	// ---- phase 2: throttled pull ~3 fps, 6 s ------------------------------
	// Freshness check: pull-to-pull PTP timestamp delta ≈ pull interval means NDI
	// hands us a CURRENT frame (backlog dropped); ≈ frame interval means backlog.
	cw = cpuWindowStart();
	let prevTs = 0; const deltas = []; let sigPrev = '', animated = 0, pulls = 0;
	const crypto = require('crypto');
	const p2End = Date.now() + 6000;
	while (Date.now() < p2End) {
		const t0 = Date.now();
		try {
			const f = await receiver.data(2000);
			if (f.type === 'video') {
				pulls++;
				const ms = tsMs(f.timestamp);
				if (prevTs) deltas.push(+(ms - prevTs).toFixed(1));
				prevTs = ms;
				const row = Math.floor(f.yres / 2) * f.lineStrideBytes;
				const sig = crypto.createHash('md5').update(f.data.subarray(row, row + f.xres * 4)).digest('hex');
				if (sigPrev && sig !== sigPrev) animated++;
				sigPrev = sig;
			}
		} catch {}
		await sleep(Math.max(0, 333 - (Date.now() - t0)));
	}
	const cores2 = cpuWindowCores(cw);
	console.log(`[recv] PHASE2 throttled 3fps: ${JSON.stringify({ pulls, animatedIntervals: animated, tsDeltasMs: deltas.slice(0, 10), recvCores: +cores2.toFixed(3) })}`);

	// ---- phase 3: teardown — drop refs + forced GC ------------------------
	console.log(`[recv] PHASE3 drop refs + gc() at t=${new Date().toISOString()} — watch sender connections`);
	receiver = null;
	global.gc();
	await sleep(4000); // sender log should show connections drop within this window

	// reconnect proves teardown left NDI usable
	let r2 = await grandiose.receive({ source, colorFormat: grandiose.COLOR_FORMAT_RGBX_RGBA, bandwidth: grandiose.BANDWIDTH_LOWEST });
	let got2 = 0;
	for (let i = 0; i < 12 && got2 < 3; i++) {
		try { if ((await r2.data(2000)).type === 'video') got2++; } catch {}
	}
	console.log(`[recv] PHASE3 reconnect after gc-teardown: ${got2 >= 3 ? 'PASS' : 'FAIL'} (${got2} frames)`);
	r2 = null;
	global.gc();
	await sleep(3000);

	// ---- phase 4: GC with a capture in flight (the dangerous case) --------
	// VERIFIED 2026-08-19: receive() on a hand-built name-only source (no
	// urlAddress) SEGFAULTS in grandiose 0.2.0 — receivers must only ever be
	// created from finder-discovered Source objects (see preview-scratch-inflight
	// for the isolation). The in-flight test therefore runs on the real source.
	let r3 = await grandiose.receive({
		source,
		colorFormat: grandiose.COLOR_FORMAT_RGBX_RGBA,
		bandwidth: grandiose.BANDWIDTH_LOWEST,
	});
	const inflight = r3.data(5000).then(
		f => `resolved:${f.type}`,
		err => `rejected:${err.code || err.message}`,
	);
	r3 = null;
	global.gc();
	console.log('[recv] PHASE4 gc() issued with data() in flight; awaiting settle…');
	const out = await inflight;
	console.log(`[recv] PHASE4 in-flight capture settled without crash: ${out}`);
	global.gc();
	await sleep(1000);
	console.log('[recv] ALL PHASES DONE');
	process.exit(0);
}

main().catch(err => { console.error('[recv] FAILED:', err); process.exit(1); });
