# ECANDI Quick Start

Your first fifteen minutes. By the end of it, one remote guest's camera will be
a named NDI stream on your network, and their microphone will be arriving
wherever you chose to send it.

ECANDI is for the person running a multi-guest live show: each guest joins
through a [vdo.ninja](https://vdo.ninja) link, and ECANDI turns each of them into **two independent
things**: a named NDI video stream, and an audio feed you can place on its own
channel of a multi-channel device. The two never touch each other, so fixing one
guest's audio never disturbs anyone's video, and you can use one without the
other.

---

## Before you start

**One thing is genuinely required:** a vdo.ninja link for each guest, either a
"solo view" link from your director's room or any `?view=…` / `?push=…` link.
That is how their camera and microphone reach your machine.

Everything else depends on what you want out of ECANDI. Its two jobs, video out
as NDI and audio placed on channels, are independent of each other, and you can
use either one, both, or a simpler version of either:

| If you want | You need | Notes |
|---|---|---|
| **Each guest's video as its own NDI stream** | Something on your network that receives NDI | Any NDI receiver works: another application, a hardware device, a monitoring tool. OBS with the DistroAV plugin is what this guide uses for examples, because it is the setup ECANDI was tested against |
| **Each guest's audio on its own channel** | A multi-channel virtual audio device | VB-Audio Matrix (or VoiceMeeter) presenting an 8-channel VAIO is the tested setup. This is what lets you treat guests as separate mixer inputs |
| **Guests' audio, but not separated** | Nothing extra | Leave the audio device and channel fields blank. Each guest's audio then plays out your normal playback device, mixed together like any other application's sound |
| **No audio from ECANDI at all** | Nothing extra | Stop each guest's audio plane from the console. Their video is completely unaffected |

Video and audio never depend on each other, so a missing piece on one side costs
you nothing on the other.

---

## 1. Install

Run **`ECANDI-setup-1.0.0.exe`**.

- Windows SmartScreen will warn you that the publisher is unknown. ECANDI v1 is
  not code-signed. Choose **More info → Run anyway**.
- The installer asks nothing except where to put it. It installs **just for
  you**, with no administrator prompt and no elevation.
- Default location: `C:\Users\<you>\AppData\Local\Programs\ECANDI`

You get **ECANDI** in the Start menu and on the desktop. Nothing else needs
installing. The custom Electron runtime, the NDI runtime, the native sender
module, and the PowerShell helpers all ship inside the app.

> **Portable option:** `ECANDI-portable-1.0.0.exe` runs without installing.
> Same app; it unpacks to a temporary folder on each launch.

---

## 2. First launch

Open **ECANDI**. You land in the console on an empty scene:

![The console on first launch](images/01-first-launch.png)

A few things to know about this window:

- **It is the only window you need.** Everything else ECANDI runs (the
  supervisor, the video host, one audio worker per guest) is a background
  process it manages for you.
- **The scene** (`default.json`, named in the title bar) is your guest list. It
  lives in `Documents\ECANDI\`, not inside the installed app, so it survives
  upgrades and uninstalls.
- **Nothing is running yet.** The red `supervisor: stopped` pill tells you so.

---

## 3. Add your first guest

Click **+ Add player**.

Copy the guest's vdo.ninja link and paste it into the top field, the one
labeled *Paste a vdo.ninja link*. ECANDI reads the link and fills in the
Stream ID for you, keeping any parameters that matter (like `&solo`) and
dropping the ones it manages itself.

![Pasting a guest link](images/02-add-player.png)

Then set three things:

1. **Name.** How this guest appears everywhere: in the console, in the NDI
   stream name, and wherever you subscribe to it. Use something short and
   real: `Alice`.
2. **Audio output device.** Where this guest's audio should play. The dropdown
   lists every playback device on the machine with its channel count, so a
   multi-channel one is easy to spot. Leave it blank to use your normal
   playback device.
3. **Channel offset.** Which channel this guest's audio lands on, counting
   from **0**. Offset `0` is channel 1, offset `1` is channel 2, and so on.
   Give every guest their own. Leave it blank if you are not separating guests
   onto channels.

Leave Width, Height, and FPS blank unless you have a reason. Blank means
1920×1080 at 30 fps, which is what most shows want.

Watch the three lines under the form as you type. They show the exact URLs and
NDI name ECANDI will use. The whole configuration is visible before you commit
to it.

Click **Save to sources.json**. The guest appears as a row.

Repeat for each guest. Give each one a different channel offset.

> **In-room links need `&solo`.** If your guests are in a vdo.ninja *room* and
> you paste a plain room view link, ECANDI will connect to nothing. The solo
> link from the director panel is the one to copy; it already has `&solo` in
> it, and pasting keeps it.

---

## 4. Start everything

Click **Start supervisor**.

ECANDI brings the guests up one at a time, video first and then audio, waiting
for each to finish loading before starting the next. Give it fifteen seconds or
so per guest. Rushing this is what breaks other setups, so ECANDI does not
rush it.

![A live session](images/03-live-session.png)

When a guest is fully up you see, on their row:

- A live **video thumbnail**, which is proof the stream is really on the
  network: ECANDI draws it by receiving its own NDI output back. **It is not
  what your receiver gets.** The thumbnail is intentionally a small, low
  frame-rate preview so that watching your guests costs almost nothing. The
  stream itself stays full resolution at the full frame rate no matter how
  coarse or stuttery the little picture looks. Judge stream quality at your
  receiver, never here.
- Green **RUNNING** chips on both planes, with the process id and live stats
  (`30 paint-fps · sent 5941 · drop 0`).
- A moving **audio meter** with the channel number beside it.

The **Audio Manager** below the rows shows the same thing channel by channel:
each channel of the device you chose, its live level, and which guest is
assigned to it. (If you left the audio fields blank, there is nothing to show
here, which is expected rather than a fault.)

---

## 5. Point your NDI receiver at the streams

Each guest is now on the network as an NDI source named **`CC-<Name>`**, so
`Alice` is `CC-Alice`. NDI receivers show it with the machine name in front:
`<YOUR-PC> (CC-Alice)`.

Whatever receives NDI on your network can pick these up. If that is OBS with the
DistroAV plugin (the setup this guide is written against), it is **Add Source →
NDI Source**, pick the guest, and set the source's bandwidth to **Highest**, once
per guest. Other receivers differ in the details but the idea is the same: find
the guest by name and subscribe to it.

The names never change when ECANDI restarts a guest, so whatever you have
pointed at them keeps working through anything ECANDI does, which is why they
are named rather than numbered.

> `CC-` is the default prefix and you can change it per scene, but you rarely
> should, because your receiver is bound to these names.

---

## 6. Route the audio

Skip this if you are not separating guests onto channels.

If you are, each guest's audio is now on its own channel of the device you
picked. From there it is your audio setup's business, not ECANDI's: in VB-Audio
Matrix (or whatever you use), each channel goes wherever you send it: to Dante,
to a mixer, to a recorder.

ECANDI's meters tell you the audio truly arrived at that device. That much
ECANDI can promise; everything past the device is your routing.

---

## 7. Two controls worth knowing before you go live

**Mute** silences one guest instantly. The row shows a red **MUTED** chip and
their meter dies; everyone else is untouched. It mutes the audio *page*, not
the routing, so unmuting is instant and nothing reconnects.

**Reload audio** is the fix for one guest's audio going wrong. It rebuilds only
that guest's audio, taking about 3 to 7 seconds. Their video does not flicker,
and no other guest is affected at all.

You will not need to restart everything to fix one person.

---

## Reading the row at a glance

| What you see | What it means | What to do |
|---|---|---|
| **RUNNING** (green) | Working normally | Nothing |
| **starting** (amber) | Coming up | Wait |
| **rebuilding** (amber) | Recovering by itself after a crash | Wait; it self-heals |
| **failed** (red) | Gave up after repeated failures | Check the guest is still connected, then **start** |
| **stopped** (grey) | You stopped it | **start** when you want it back |
| **MUTED** (red) | You muted this guest | **unmute** |
| **audio misrouted — reload audio** (red) | Their audio is playing to the wrong device | **reload** on the audio plane |
| **PGM** (red) / **PVW** (green) | Your receiver has this guest live / in preview | Nothing; it's information. Only receivers that send NDI tally will light these |
| Empty meter, RUNNING chips | Their mic is muted or silent | Ask them to check their mic |

---

## Shutting down

**Stop everything** stops all guests and the supervisor, and asks first.

Closing the ECANDI window does **not** stop your show. The guests keep
streaming, and reopening ECANDI reconnects you to the running session. That is
deliberate: the console can crash without taking your broadcast with it.

---

## Where things live

| What | Where |
|---|---|
| Your scenes (guest lists) | `Documents\ECANDI\` |
| The running log | `Documents\ECANDI\supervisor.log` |
| Your settings (theme, window) | `%APPDATA%\ECANDI` |
| The app itself | `%LOCALAPPDATA%\Programs\ECANDI` |

Only the last one is removed when you uninstall.

---

Next: **[MANUAL.md](MANUAL.md)**, covering every control, every state, and what
to do when something looks wrong.
