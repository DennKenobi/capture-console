# ECANDI Operator's Manual

Everything the console can do, what every indicator means, and what to do when
something looks wrong.

If you have never run ECANDI before, read **[QUICKSTART.md](QUICKSTART.md)**
first. This manual assumes you have had one guest working at least once.

**Contents**

1. [How ECANDI is put together](#1-how-ecandi-is-put-together)
2. [Scenes](#2-scenes)
3. [The player table](#3-the-player-table)
4. [The Audio Manager](#4-the-audio-manager)
5. [Previews, pop-outs, and meters](#5-previews-pop-outs-and-meters)
6. [Mute and solo](#6-mute-and-solo)
7. [Tally](#7-tally)
8. [Troubleshooting](#8-troubleshooting)
9. [Configuration reference](#9-configuration-reference)
10. [Where files live](#10-where-files-live)

---

## 1. How ECANDI is put together

You see one window. Behind it, ECANDI runs several processes, and knowing the
shape of them makes every message in this manual easier to read.

```
     ECANDI console  ──────►  supervisor  ──┬──►  video host   (all guests' video)
     (the window you see)     (no window)   ├──►  audio worker (guest 1)
                                            └──►  audio worker (guest 2, 3, …)
```

- **The console** is the window. It edits your scene, sends commands, and shows
  you what is happening. It carries none of your video or audio.
- **The supervisor** starts everything, watches it, and restarts what dies. It
  has no window and keeps running if the console closes.
- **The video host** is one process holding every guest's video. One shared
  process is deliberate: it uses about 40% less CPU than one process per guest,
  and video carries no audio state, so nothing is risked by sharing.
- **Each guest's audio is its own separate process.** Audio is the fragile
  plane, so it gets full isolation: one guest's audio can crash, be rebuilt, or
  be reassigned without any other guest, or any video, noticing.

Three consequences follow from that:

**Closing the console does not stop your show.** The supervisor and workers keep
running. Reopening ECANDI on the same scene reconnects you to the live session,
with all state intact. If the console ever misbehaves mid-show, close it and
reopen it.

**Nothing is ever changed on a running guest.** Every change (a new channel, a
different device, a resolution) is applied by rebuilding that one piece from
your saved configuration. This is why fixing one guest never disturbs another.

**Video and audio are separately delivered.** A guest's video reaching your NDI
receiver and their audio reaching your playback device are two independent
facts. Either can be true without the other, and you are free to use only one
of the two.

---

## 2. Scenes

A **scene** is your guest list plus the defaults that apply to them, saved as a
`.json` file in `Documents\ECANDI\`. The file name shows in the title bar and
next to the ECANDI wordmark.

| Button | What it does |
|---|---|
| **New scene** | Creates an empty scene, keeping your current defaults (same studio, different show) |
| **Open…** | Switches to another scene file |
| **Save As…** | Saves the current scene under a new name and switches to it |

**Switching scenes while a supervisor is running** is never silent. ECANDI asks
you to choose:

- **Stop everything, then switch** is the clean choice between shows. It waits
  for every worker to shut down properly.
- **Leave it running and switch** keeps the session going without a console
  attached. Reopening that scene later reconnects you to it.
- **Cancel**.

> **One supervisor per folder.** Scenes in the same folder share their
> coordination files, so only one can run at a time. If you open a scene while a
> *different* scene's session is running in that folder, ECANDI shows a warning
> pill and refuses to send commands rather than talking to the wrong session.
> Keep separate shows in separate folders if you need both running.

An **empty scene is valid.** A fresh scene with no guests starts a working (idle)
session; add guests and press **Rescan config** to bring them in.

---

## 3. The player table

One row per guest, with a video plane and an audio plane side by side.

### The state chip

The first thing in each plane cell:

| Chip | Color | Meaning |
|---|---|---|
| **RUNNING** | green | Up and working |
| **starting** | amber | Launching, or loading the page |
| **backoff** | amber | Failed, waiting before the next automatic retry |
| **rebuilding** | amber | Its window crashed; the host is rebuilding it in place |
| **failed** | red | Gave up after repeated failures; retries every 5 minutes anyway |
| **stopped** | grey | You stopped it |
| **parked** | grey | Retired but still holding its NDI name until the host restarts |

Two more you'll see when things aren't wired up rather than broken:

- **no supervisor** means nothing is running. Press **Start supervisor**.
- **no worker — rescan to start** means the supervisor is running but does not
  know about this guest. Press **Rescan config**.
- **not in host — rescan** *(on the video thumbnail)* is the same situation,
  seen from the video host's side.

### The other chips

| Chip | Meaning | What to do |
|---|---|---|
| **MUTED** | You muted this guest | **unmute** |
| **audio misrouted — reload audio** | Their audio is genuinely playing to the wrong device | **reload** on the audio plane. Hover it to see where the audio actually went |
| **PGM** | Your receiver has this guest on program | Information only |
| **PVW** | Your receiver has this guest in preview | Information only |

### The stats line

`30 paint-fps · sent 5941 · drop 0 · lat 3.9ms · 232MB`

- **paint-fps** is frames per second arriving from the guest. This follows
  *their* camera and connection, not a setting of yours.
- **sent** is frames pushed to NDI since this guest started.
- **drop** is frames deliberately discarded because the sender was still busy.
  A handful over a long session is normal and harmless. Thousands means the
  machine is overloaded.
- **lat** is how long a frame takes through ECANDI's own pipeline. Single-digit
  milliseconds is healthy.

### The buttons

| Button | Plane | Effect |
|---|---|---|
| **reload** | either | Rebuilds that one plane from the saved configuration. Video takes ~2 s and does not drop the NDI stream; audio takes about 3 to 7 s |
| **stop** | either | Stops that plane. It stays stopped until you start it |
| **start** | either | Starts a stopped plane |
| **preview: on/off** | video | Turns this row's thumbnail on or off |
| **pop out** | video | Opens the thumbnail as its own small window |
| **mute / unmute**, **solo** | audio | See [Mute and solo](#6-mute-and-solo) |
| **Edit** | row | Opens the configuration form |
| **Remove** | row | Deletes the guest (asks first) and rescans |

### Adding and editing guests

**Edit** (or **+ Add player**) opens the form. Paste a vdo.ninja link in the top
field and ECANDI fills in the Stream ID and room, keeps parameters it doesn't
manage (like `&solo` and passwords), and drops the ones it sets itself.

The three lines below the form show the exact video URL, audio URL, and NDI name
that will be used. Check them before saving.

- **Saving a new guest** rescans automatically, bringing them up.
- **Saving an edit to an existing guest** only writes the file. Press **reload**
  on the affected plane to apply it. That way you choose the moment a live guest
  gets rebuilt.

---

## 4. The Audio Manager

Below the table: one block per audio device in use, one row per channel, showing
each channel's live level and which guest is assigned to it. Guests with no
channel yet pool under **Unassigned**.

**To move a guest to another channel:** click their chip, then click the channel
row you want. Nothing has happened yet: the move is *staged*, and the staged
line tells you what will happen. Then:

- **Connect** saves the configuration and rebuilds that guest's audio. Their
  audio is silent for about 3 to 7 seconds. Their video does not move, and no
  other guest is affected.
- **Discard** forgets the staged move.

Assigning onto an occupied channel is refused before anything is staged; the
grid will tell you who is already there.

The channel row shows both numbers: `ch3  off 2` means channel 3, which is
`channelOffset: 2` in the file. Channels count from 1; offsets count from 0.

---

## 5. Previews, pop-outs, and meters

### Previews

The thumbnail on each row is **ECANDI receiving its own NDI stream back over the
network**, at an intentionally small, low-bandwidth, low-frame-rate proxy. That
makes it honest about one thing and silent about another:

- **What it proves:** if the thumbnail is moving, that guest's stream really is
  on the network and a receiver can get it. It is end-to-end evidence, not a
  local guess.
- **What it does not show:** the quality your receiver gets. The thumbnail is a
  fraction of the resolution and frame rate of the real stream, so it can look
  soft or stuttery while the actual output is perfectly smooth at full
  resolution. **Never judge stream quality from the thumbnail.** Check the
  `paint-fps` and `drop` figures in the row, or look at the stream in your
  receiver.

- **Previews: ON/OFF** in the top bar toggles all rows; **preview: on/off**
  toggles one row.
- Turning a preview off genuinely disconnects the receiver. This matters: a
  connected receiver makes the sender do extra encoding work. All six previews
  cost about 0.08 CPU cores on the sending side. That is small, but if you are
  chasing performance, turn them off.
- A thumbnail that **dims** has had no new frame for a few seconds. A stopped or
  parked guest's last frame stays on screen, so the dimming and the badge are how
  you tell a frozen picture from a live one.

**Pop out** opens the same frames in a separate small window, useful for
watching one guest while you work elsewhere. Pop-outs create no additional
network load and close with the console.

### Meters

The bar on each audio plane is the **actual signal level at the audio device**,
read from Windows, not something ECANDI infers. If the bar moves, that guest's
audio genuinely arrived on that channel.

Two things to know about reading them:

- **They fall slowly.** Virtual-cable meters decay at roughly 7 dB per second, so
  a hard cut takes several seconds to visibly reach zero. Wait about 6 to 7
  seconds before concluding a channel is dead.
- **Grey meters mean the meter helper died**, not that audio stopped. ECANDI
  restarts it automatically within seconds.

---

## 6. Mute and solo

**Mute** silences one guest at the ECANDI end. It mutes the audio page's output;
it does not change routing, touch the audio graph, or reconnect anything.
Unmuting is immediate and the stream never drops.

**Solo** mutes everyone else.

Mute is a live action, not part of your saved scene, so:

- It is **not** written to the scene file.
- If a muted guest's audio is rebuilt, ECANDI re-applies the mute within a few
  seconds (a fresh page always starts unmuted).
- Closing the console forgets your mute intentions; the guests keep whatever
  mute state they currently have, and the reopened console shows the truth.

The **MUTED** chip plus a dead meter is the proof it worked: the chip alone
reports intent, the meter reports reality.

---

## 7. Tally

When a receiver puts a guest on program or preview and reports that upstream
(OBS with DistroAV does, and is what this was verified against), the state
travels back to ECANDI and tints the row, with a **PGM** or **PVW** chip.

Expect the highlight to follow a scene change within a few seconds. If you want
it snappier, lower `tallySec` (see the [configuration
reference](#9-configuration-reference)).

Not every NDI consumer sends tally. NDI Studio Monitor, for instance, does not,
even with its tally setting on. A blank tally state therefore means "nothing is
telling us", not "nobody is watching".

---

## 8. Troubleshooting

### A guest's video never appears

Check the video plane chip first.

- **starting** for a long time usually means the guest's browser is not
  connected. Confirm they are actually live on the vdo.ninja link.
- **failed** means ECANDI tried and gave up; it retries every 5 minutes. Press
  **start** once the guest is definitely online.
- **The thumbnail shows a static picture.** Look for dimming and a badge. A
  parked or stopped surface keeps its last frame.

If the link came from a vdo.ninja **room**, make sure it is a **solo** link. An
in-room view link without `&solo` connects to nothing and gives no error.

### A guest has no audio

Work through it in this order, because each step distinguishes two different
faults:

1. **Is their meter completely flat, with RUNNING on the audio plane?**
   Then ECANDI is connected and receiving silence. The usual cause is a muted or
   wrong microphone at the guest's end. A live but quiet room still reads a small
   non-zero level; a genuinely muted mic reads flat zero.
2. **Is there an `audio misrouted — reload audio` chip?**
   Their audio is playing, but to the wrong device. vdo.ninja occasionally
   loses the race to pick the output device and falls back to the system
   default. Press **reload** on the audio plane. Hovering the chip tells you
   where the sound actually went.
3. **Is the audio plane chip `failed` or `stopped`?**
   Press **start**.
4. **Are they on the channel you think?**
   Check the Audio Manager. Remember offset 0 = channel 1.

### Everything is choppy

Look at **drop** and **paint-fps** across the rows.

- **Low paint-fps on one guest, others fine** points at that guest's connection
  or camera, not at your machine.
- **Everything degraded at once** means the machine is saturated. Close what
  you can, turn previews off, and consider lowering resolution for some guests
  (720p costs roughly half of 1080p). ECANDI degrades gracefully under load and
  recovers on its own when the pressure lifts.

In our testing, a guest on Chrome or Edge cost noticeably less than the same
guest on Firefox. That is worth suggesting to a guest whose feed is struggling,
though your mileage may differ.

### A guest's NDI name won't come back after removing and re-adding them

ECANDI handles this automatically now by reusing the parked sender. If you ever
see a guest stuck starting with a blank preview right after a delete-and-re-add,
restarting the supervisor clears it.

> **Restarting the supervisor affects every guest, not just the stuck one.**
> **Stop everything** followed by **Start supervisor** tears down all video and
> all audio and brings the whole set back up, sequenced, taking roughly fifteen
> seconds per guest before everything is live again, during which every stream
> is down. Treat it as a between-shows fix. If you are live and only one guest
> is affected, leave them broken until a break rather than dropping everybody.

NDI names linger for several minutes after a process exits, by design of NDI
itself; ECANDI retries patiently rather than renaming the stream, because your
receiver is bound to the name.

### The console won't send commands and shows a warning pill

Another scene in the same folder is running. See [Scenes](#2-scenes).

### Something is deeply wrong and I want a clean slate

**Stop everything**, wait for the rows to go grey, then **Start supervisor**.
If the console itself is unresponsive, close it (the workers survive) and
reopen it.

### The log

`Documents\ECANDI\supervisor.log` has every worker's output with timestamps. It
rotates at 5 MB, keeping one previous generation as `supervisor.log.1`. When
something is unexplained, the answer is almost always in there.

---

## 9. Configuration reference

Everything in the editor maps to a field in the scene file. You can edit the
file directly when ECANDI is closed; the console never mutates a running guest
from it without you asking.

### Per-guest fields

| Editor field | File field | Notes |
|---|---|---|
| Name | `name` | Must be unique. Used in logs and as the NDI name's suffix |
| Stream ID | `streamId` | The vdo.ninja stream identifier |
| Room | `room` | Blank inherits the scene default |
| NDI name | `video.ndiName` | Blank means `<prefix><Name>` |
| Width / Height / FPS | `video.width/height/fps` | Blank inherits defaults. 320-3840 wide, 180-2160 high, 1-120 fps |
| Video extra params | `video.extraParams` | Appended raw to the video URL |
| Audio output device | `audio.audioOutputDevice` | A **label fragment** matching exactly one playback device |
| Channel offset | `audio.channelOffset` | 0-7, meaning channels 1-8. Must be unique per device |
| Channels | `audio.channels` | Almost always 8. Required for multi-channel placement |
| Audio extra params | `audio.extraParams` | Appended raw to the audio URL |

**About the audio device fragment:** it matches by normalized substring, and the
first match wins, so it must be unique to one device. On a machine with eight
`VBMatrix In N (VB-Audio Matrix VAIO)` endpoints, the fragment `VAIO` matches
all eight unpredictably, while `VBMatrix In 6` matches exactly one. The editor's
dropdown gives you full labels, so use it rather than typing.

### Scene defaults

Anything a guest leaves blank falls back to `defaults`:

| Field | Default | Notes |
|---|---|---|
| `ndiPrefix` | `CC-` | Changing it renames every stream; anything subscribed to them will need repointing |
| `vdoBase` | `https://vdo.ninja/` | For self-hosted instances |
| `videoTopology` | `consolidated` | `per-player` gives one process per guest: more isolation, ~40% more CPU |
| `video.senderMode` | `native` | `inline` is a fallback path costing about twice the CPU. ECANDI switches to it by itself if the native module can't load |
| `video.statsSec` | `10` | How often the stats line updates, 2-120 s |
| `video.tallySec` | `2` | How often tally is polled. Lower means a snappier PGM highlight |
| `video.ndiDepth` | 8 inline / 2 native | Send pipeline depth. Leave it alone unless you're benchmarking |

### What ECANDI checks before saving

Unique names, unique NDI names, channel offsets in range and unique per device,
and resolution/framerate within limits. A scene that fails validation is not
saved and the console tells you why.

---

## 10. Where files live

| What | Where | Survives uninstall |
|---|---|---|
| Scenes | `Documents\ECANDI\*.json` | **Yes** |
| Log | `Documents\ECANDI\supervisor.log` | **Yes** |
| Worker profiles | `Documents\ECANDI\.workers\` | **Yes** |
| Console settings (theme, window) | `%APPDATA%\ECANDI` | **Yes** |
| The application | `%LOCALAPPDATA%\Programs\ECANDI` | No; this is what gets removed |

Upgrading ECANDI replaces only the last row. Your scenes, logs, and settings are
untouched by both upgrade and uninstall.

Alongside the app you'll also find `NOTICE.md` (licensing and the NDI terms that
travel with the software) and `LICENSE.md` (ECANDI is GPL-3.0, derived from
Steve Seguin's Electron Capture).

---

*NDI® is a registered trademark of Vizrt NDI AB. ECANDI is not a product of
Vizrt NDI AB.*
