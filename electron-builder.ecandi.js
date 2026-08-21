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
	// Upstream's README, preserved at the repo root for attribution but not
	// app content (package.json's filter already drops our own README.md).
	'!README.upstream.md',
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
		// Windows reads the fields below straight into the Add/Remove Programs
		// entry, so upstream's values made ECANDI appear as software published by
		// Steve Seguin, linking to his repository (measured on a real install,
		// Session 11). That is both wrong and the opposite of what NOTICE.md
		// states. These are packaged-only: the dev tree's package.json, and
		// Steve's authorship of the upstream work in LICENSE/NOTICE/README, are
		// untouched. "Publisher" means who ships THIS build.
		// Must be the OBJECT form: electron-builder reads `author.name`, so a
		// plain string silently yields an EMPTY Publisher (measured).
		author: { name: 'Just Create Labs LLC' },
		homepage: 'https://github.com/DennKenobi/ecandi',
		repository: { type: 'git', url: 'https://github.com/DennKenobi/ecandi.git' },
		bugs: { url: 'https://github.com/DennKenobi/ecandi/issues' },
		// Shows as "Comments" in Add/Remove Programs. Functional description
		// only: the product is not branded with the NDI name (Dennis,
		// 2026-08-20), and no em dashes in operator-visible text.
		description: 'Multi-guest capture console for live production',
		// Electron's app.getName() reads the PACKAGED package.json's productName,
		// falling back to name — and upstream's productName lives under "build",
		// which Electron never sees. Without this the installed profile lands in
		// %APPDATA%\VDON.Electron.Capture.App (measured, Session 11 Part B).
		// SESSION11-SPEC §1 assumed userData already followed productName; it did
		// not. Packaged-only, so the dev tree is untouched.
		productName: 'ECANDI',
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
	// Distribution obligations travel with the artifact, readable next to the exe
	// without unpacking an asar: GPL-3.0 (fork of Electron Capture) and the NDI
	// license's required notices/terms (§3d/f/g — Session 11 license read).
	extraFiles: [
		{ from: 'LICENSE.md', to: 'LICENSE.md' },
		{ from: 'NOTICE.md', to: 'NOTICE.md' },
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
		uninstallerIcon: 'assets/ecandi.ico',
		installerHeaderIcon: 'assets/ecandi.ico',
		// Without these the welcome/finish pages carry electron-builder's stock
		// blue graphic and the installer reads as a generic Electron app.
		// Generated by scripts/make-ecandi-sidebar.js (164x314, 24-bit BMP).
		installerSidebar: 'assets/ecandi-sidebar.bmp',
		uninstallerSidebar: 'assets/ecandi-sidebar.bmp',
		// Upstream's installer.nsh is elecap's PATH-entry machinery (ECANDI is an
		// operator GUI app, not a CLI, so there is nothing to add to PATH). Ours
		// only fills in the Add/Remove Programs fields electron-builder leaves
		// blank, so Windows can show the install location and size.
		include: 'build/ecandi-installer.nsh',
		// Per-user install, no elevation (SESSION11-SPEC §1). perMachine:false +
		// allowElevation:false pins it: no UAC prompt, no install-mode page, lands
		// in %LOCALAPPDATA%\Programs\ECANDI.
		perMachine: false,
		allowElevation: false,
		// Shortcuts (Start menu + desktop) read ECANDI, not the package name.
		shortcutName: 'ECANDI',
		uninstallDisplayName: 'ECANDI ${version}',
		// Uninstall honesty (SESSION11-SPEC §3): scenes live in Documents\ECANDI and
		// the console profile in %APPDATA%\ECANDI — both outside the install dir, so
		// neither an upgrade nor an uninstall can touch an operator's work. Explicit
		// here because the default silently does the right thing and a future edit
		// flipping it would be a data-loss bug.
		deleteAppDataOnUninstall: false,
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
