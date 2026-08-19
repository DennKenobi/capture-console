# sources.json — Capture Console source configuration

The single source of truth (ARCHITECTURE.md §2 "Config Store"). The supervisor compiles each
entry into two immutable view URLs at spawn time; **no parameter is ever changed on a live
surface** — edits here take effect only via per-plane rebuild.

```jsonc
{
  "defaults": {
    "room": "",                       // vdo.ninja room, if used
    "vdoBase": "https://vdo.ninja/",
    "ndiPrefix": "CC-",               // ndiName fallback = ndiPrefix + name (use-case-neutral; never assume a purpose-specific prefix)
    "videoTopology": "consolidated",  // "consolidated" (one video-host process, default; Session 5 bench) | "per-player" (one slice-main process per player)
    "video": { "width": 1920, "height": 1080, "fps": 30,
               "ndiDepth": 8 },       // optional: NDI send-pipeline depth for the consolidated host (default 8; per-player workers use 2)
    "audio": { "audioOutputDevice": "VBMatrix In 6" }  // label fragment unique to ONE endpoint — see below
  },
  "sources": [
    {
      "name": "Alice",                // unique; used in logs, worker ids, NDI fallback name
      "room": "",                     // overrides defaults.room ("" = inherit)
      "streamId": "alice_stream_id",  // vdo.ninja push/stream ID
      "video": {
        "ndiName": "",                // optional explicit NDI name; empty → "CC-Alice"
        "width": 1920, "height": 1080, "fps": 30,
        "extraParams": ""             // raw vdo.ninja params appended to the video URL
      },
      "audio": {
        "audioOutputDevice": "",      // "" = inherit defaults.audio.audioOutputDevice
        "channelOffset": 0,           // 0-7 → device channel 1-8 (mono placement)
        "extraParams": ""             // raw vdo.ninja params appended to the audio URL
      }
    }
  ]
}
```

## Field semantics

- **Resolution/framerate are per-source options** — {720p, 1080p} × {30, 60} minimum
  supported range, mixed freely across sources. Nothing downstream clamps them.
- **`audioOutputDevice` is a device-label fragment**, not a device ID. vdo.ninja's
  `&audiooutput=` matches by normalized substring (`\W+`→`_`, lowercased) of the output
  device label; **first enumerated match wins**, so the fragment must be unique to ONE
  endpoint. Concrete example from the capture host: VB-Audio Matrix exposes eight endpoints
  all containing "VAIO" (`VBMatrix In 1 (VB-Audio Matrix VAIO)` … `In 8`) — `"VAIO"` alone is
  ambiguous/nondeterministic there. Use the input carrying the 8-channel config: on this
  host that is `"VBMatrix In 6"` (the only ch=8 endpoint per the loopback probe; the rest
  are stereo). Device IDs (`&sink=`) are profile-salted by Chromium and never survive fresh
  worker data dirs — do not use them.
- **`channelOffset`** maps mono audio onto channel *offset+1* of the output device
  (verified 2026-08-17 bench: no offset = stereo ch1/2; offset 0-5 = mono ch1-6).
- **URLs produced** (see `url-builder.js`):
  - video plane: `<base>?view=<id>[&room=…]&noaudio[&extra]`
  - audio plane: `<base>?view=<id>[&room=…]&novideo&audiooutput=<dev>&channeloffset=<n>[&extra]`
- Validation (`validateConfig`): unique names, unique NDI names, channelOffset 0-7 and
  unique per device, width 320-3840 / height 180-2160 / fps 1-120.
