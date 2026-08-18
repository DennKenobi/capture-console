// NDI receive probe — dev/verification tool for the Capture Console fork.
// Discovers a source by name fragment, pulls frames, reports geometry/fps/liveness.
//   node capture/ndi-probe.js --name=CC-SLICE [--frames=60] [--json]
const grandiose = require('@stagetimerio/grandiose');
const crypto = require('crypto');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const NAME = arg('name', 'CC-SLICE');
const FRAMES = parseInt(arg('frames', '60'), 10);
const JSON_OUT = process.argv.includes('--json');

async function main() {
	const finder = await grandiose.find({ showLocalSources: true });
	let source = null;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline && !source) {
		await finder.wait(2000).catch(() => false);
		source = finder.sources().find(s => s.name.includes(NAME));
	}
	await finder.destroy();
	if (!source) throw new Error(`source containing "${NAME}" not found within 20s`);

	const receiver = await grandiose.receive({ source, colorFormat: grandiose.COLOR_FORMAT_BGRX_BGRA });
	let got = 0, t0 = 0, changes = 0, nonVideo = 0, lastSig = '', geometry = null;
	while (got < FRAMES) {
		const f = await receiver.data(8000);
		if (f.type !== 'video') { nonVideo++; continue; }
		if (got === 0) { t0 = Date.now(); geometry = { xres: f.xres, yres: f.yres, stride: f.lineStrideBytes }; }
		const rowStart = Math.floor(f.yres / 2) * f.lineStrideBytes;
		const sig = crypto.createHash('md5').update(f.data.subarray(rowStart, rowStart + f.xres * 4)).digest('hex');
		if (lastSig && sig !== lastSig) changes++;
		lastSig = sig;
		got++;
	}
	const fps = (FRAMES - 1) / ((Date.now() - t0) / 1000);
	const result = { source: source.name, ...geometry, fps: +fps.toFixed(2), animatedIntervals: changes, of: FRAMES - 1, nonVideoSkipped: nonVideo };
	if (receiver.destroy) await receiver.destroy();
	if (JSON_OUT) console.log(JSON.stringify(result));
	else console.log(`[probe] ${result.source}: ${result.xres}x${result.yres} @ ${result.fps}fps, animated ${changes}/${FRAMES - 1}`);
	if (fps < 25) throw new Error(`fps below threshold: ${fps.toFixed(2)}`);
}

main().then(() => process.exit(0)).catch(err => { console.error('[probe] FAILED:', err.message); process.exit(1); });
