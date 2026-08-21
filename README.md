# ECANDI

**ECANDI takes the guests of a live show, joining from anywhere through a
browser link, and turns each of them into two things your production can use
independently: a named NDI video stream on your network, and an audio feed you
can place on its own channel.**

Each guest becomes a separate NDI source for your switcher and a separate input
at your mixer. The two planes never share state, so rebuilding one guest's audio
does not disturb their video, and rebuilding one guest does not disturb any
other. That independence is the point.

Windows, and currently v1.0.0.

---

## Built on Electron Capture and vdo.ninja

ECANDI exists because of two incredible projects by **Steve Seguin**:

- **[vdo.ninja](https://vdo.ninja)** is how the guests get here at all. Getting
  live camera and microphone out of someone's browser, anywhere in the world,
  with nothing for them to install and no account to make, is the genuinely hard
  problem, and it is solved. Every guest in ECANDI arrives through a vdo.ninja
  link. ECANDI drives it only through public, documented URL parameters and
  never injects or patches anything inside the page.
- **[Electron Capture](https://github.com/steveseguin/electroncapture)** is the
  application this repository is a fork of. It contributes the window and
  capture foundation, and the custom Electron runtime Steve maintains, whose
  patches ECANDI inherits and ships.

What ECANDI adds is narrow next to that: it runs many guests at once instead of
one window at a time, splits each into an independent video stream and audio
channel, and puts a supervisor around the set. It is an addition to Steve's
work, not a replacement for it.

ECANDI is not affiliated with or endorsed by Steve Seguin or vdo.ninja.

Steve's original README for Electron Capture is preserved here as
[README.upstream.md](README.upstream.md).

---

## Documentation

| Document | For |
|---|---|
| [Introduction](ecandi-docs/README.md) | What ECANDI is, the problem it solves, and what it needs |
| [Quick Start](ecandi-docs/QUICKSTART.md) | Getting one guest working, start to finish |
| [Operator's Manual](ecandi-docs/MANUAL.md) | Every control, indicator, and failure state |

The same documents are available inside the app from the **Help** button.

---

## Installing

Run `ECANDI-setup-1.0.0.exe`. It installs per user, needs no administrator
rights, and asks nothing except where to put it. A portable build is also
available and runs without installing.

ECANDI v1 is not code-signed, so Windows SmartScreen will warn that the
publisher is unknown.

Nothing else needs installing. The custom Electron runtime, the NDI runtime, the
native sender module, and the PowerShell helpers all ship inside the app.

Your scenes live in `Documents\ECANDI\` and your settings in `%APPDATA%\ECANDI`,
both outside the install directory, so upgrading and uninstalling leave them
alone.

---

## Building from source

Requires Windows, Node 22+, Visual Studio Build Tools with the C++ workload, and
Python 3 for node-gyp.

```bash
WINDOW_AUDIO_CAPTURE_SKIP=1 CUSTOM_ELECTRON_WINDOWS_VARIANT=win11 npm install
npm run build:ecandi
```

Both environment variables matter. The first skips a private submodule that
external clones cannot fetch; the second selects the custom Electron variant
ECANDI runs on, and without it the install replaces the runtime with a different
build.

`npm run pack:ecandi` produces an unpacked application directory without
building installers, which is faster when you only want to test.

---

## What is ECANDI's, and what is inherited

Fork-original, added by this project:

```
capture/          the console, supervisor, video host, audio workers, NDI senders
ecandi-docs/      operator documentation (markdown source plus rendered HTML)
native-modules/ndi-texture-send/   GPU texture readback and NDI send
scripts/          ECANDI build, icon, sidebar, and docs-render helpers
electron-builder.ecandi.js         packaging configuration
```

Everything else is Electron Capture's, kept as close to upstream as possible so
that merging Steve's changes stays cheap.

---

## License

GPL-3.0-only, inherited from Electron Capture, with upstream attribution
preserved. See [LICENSE.md](LICENSE.md).

[NOTICE.md](NOTICE.md) lists everything bundled and the terms that travel with
it, including the NDI SDK's redistribution requirements.

NDI® is a registered trademark of Vizrt NDI AB. ECANDI is not a product of
Vizrt NDI AB and is not endorsed by them; NDI is named here only to say what
ECANDI is compatible with.
