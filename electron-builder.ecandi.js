'use strict';

// ECANDI packaging config — Session 11 (SESSION11-SPEC §1/§2/§3). Fork-only file:
// extends electron-builder.win11.js, which already pins the runtime the fork
// actually RUNS — custom Electron 43.3.0-qp20 (win11 variant). Extending it is
// the deliberate fix for the runtime landmine: package.json's build block pins
// the win10 39.8.10-qp20 and must never drive an ECANDI build. Verified in the
// packaged app via process.versions.electron (Session 11 verify chain).
//
//   npx electron-builder --config electron-builder.ecandi.js --win --x64 --dir   (topology verify)
//   npm run build:ecandi                                                          (installer + portable)
//
// Every deviation from upstream's config is a sanctioned packaging surface
// (SESSION11-SPEC §0) and ledgered in fork CLAUDE.md Session 11.

const win11 = require('./electron-builder.win11.js');

// Deep-clone upstream's files spec so the fork's additions never mutate the
// shared object (win11 spreads package.json's build by reference).
const files = JSON.parse(JSON.stringify(win11.files));

// files[0] is upstream's big root filter. ECANDI additions:
files[0].filter.push(
	// Dev-tree launcher — retired as the primary path this session; dev only.
	'!ECANDI.cmd',
	// grandiose ships RUNTIME only: dist/index.js + grandiose.node + NDI DLL.
	// The ndi/ SDK tree (fetched at install; headers + import libs), the local
	// compile dirs, and dist's own include/lib copies are build-time — and the
	// NDI SDK must never be redistributed beyond the runtime DLL its license
	// covers (SESSION11-SPEC §2; license position in the Session 11 ledger).
	'!node_modules/@stagetimerio/grandiose/ndi/**',
	'!node_modules/@stagetimerio/grandiose/build/**',
	'!node_modules/@stagetimerio/grandiose/src/**',
	'!node_modules/@stagetimerio/grandiose/scripts/**',
	'!node_modules/@stagetimerio/grandiose/node_modules/**',
	'!node_modules/@stagetimerio/grandiose/dist/include/**',
	'!node_modules/@stagetimerio/grandiose/dist/lib/**',
);

// The fork's own native module (Session 6) — upstream's files spec excludes
// native-modules/** wholesale and re-adds per-module runtime subsets; ECANDI
// follows the same pattern for ndi-texture-send. The DLL must sit beside the
// .node: process.dlopen uses LOAD_WITH_ALTERED_SEARCH_PATH, so dependent DLL
// resolution starts in the .node's own (asar-unpacked) directory.
files.push(
	{
		from: 'native-modules/ndi-texture-send',
		to: 'native-modules/ndi-texture-send',
		filter: ['index.js', 'package.json'],
	},
	{
		from: 'native-modules/ndi-texture-send/build/Release',
		to: 'native-modules/ndi-texture-send/build/Release',
		filter: ['ndi_texture_send.node', 'Processing.NDI.Lib.x64.dll'],
	},
);

module.exports = {
	...win11,
	// Own identity (SESSION11-SPEC §1): stock Electron Capture (capture.electron)
	// runs on these rigs; a shared appId would collide installer registry and
	// taskbar AUMIDs. Reverse-DNS of the registered ecandi.app.
	appId: 'app.ecandi',
	files,
	// Packaged entry: capture/ecandi-entry.js dispatches --ecandi-role (console /
	// vhost / audio / slice). extraMetadata rewrites "main" only inside the
	// packaged asar — the dev tree's package.json keeps upstream's main.js.
	extraMetadata: {
		main: 'capture/ecandi-entry.js',
		description: 'ECANDI — NDI capture console for vdo.ninja multi-guest production',
	},
	asarUnpack: [
		...(win11.asarUnpack || []),
		// Real-file twins for everything external consumers execute by path:
		// powershell -File helpers and the ELECTRON_RUN_AS_NODE supervisor entry
		// (+ its relative requires). Measured, not assumed — Session 11 chain (5).
		'capture/**',
		// grandiose loads dist/grandiose.node which loads the NDI DLL beside it.
		'node_modules/@stagetimerio/grandiose/dist/**',
	],
	win: {
		...win11.win,
		icon: 'assets/ecandi.ico',
		// Unsigned for v1 (SESSION11-SPEC §1) — SmartScreen warnings accepted;
		// upstream's CODE_SIGNING.md documents the machinery if ever wanted.
		signtoolOptions: undefined,
	},
	nsis: {
		...win11.nsis,
		artifactName: 'ECANDI-setup-${version}.${ext}',
		installerIcon: 'assets/ecandi.ico',
		// Upstream's installer.nsh is elecap's PATH-entry machinery — ECANDI is an
		// operator GUI app, not a CLI; nothing to add to PATH.
		include: undefined,
	},
	portable: {
		...win11.portable,
		artifactName: 'ECANDI-portable-${version}.exe',
	},
	// Fuses: upstream's set minus the RunAsNode disable (the console→supervisor
	// self-spawn pattern requires ELECTRON_RUN_AS_NODE) — see scripts/ecandi-fuses.js.
	afterPack: './scripts/ecandi-fuses.js',
	// Upstream's afterAllArtifactBuild zips elecap-named artifacts — not ours.
	afterAllArtifactBuild: undefined,
};
