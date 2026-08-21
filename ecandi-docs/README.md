# ECANDI

**ECANDI takes the guests of a live show, joining from anywhere through a
browser link, and turns each of them into two things your production can use
independently: a named video stream on your network, and an audio feed you can
place on its own channel.**

That is the whole idea. Everything else in ECANDI exists to keep those two
things reliable while a show is running.

---

## What problem it solves

Getting several remote guests into a live production is easy to do badly. The
usual approaches make every guest depend on the same fragile thing: one browser
window holding everyone, one capture source, one audio device shared by all. It
works until a guest's connection wobbles, or someone needs their microphone
moved, and the fix disturbs everybody.

ECANDI is built around the opposite assumption: **something will go wrong with
one guest, mid-show, and fixing them must cost nothing to anyone else.**

So each guest gets:

- **Their own video stream**, published on your network under a stable name, for
  any NDI receiver to subscribe to.
- **Their own audio feed**, which you can place on a dedicated channel of a
  multi-channel device, so your mixer sees each guest as a separate input
  rather than one blended feed.

These two travel entirely separate paths and never share state. Rebuilding a
guest's audio does not touch their video. Rebuilding one guest does not touch
any other. That independence is the product.

---

## Who it is for

Someone running a recurring live show with remote participants who wants each
participant under individual control (separate levels, separate treatment,
separate framing) without babysitting a pile of browser windows.

You do not need to be a developer. You do need to know what you want your video
and audio to end up in: some NDI receiver, and some audio destination.

---

## How it works, briefly

Guests join through **vdo.ninja** links, the same links you would send them
anyway. ECANDI opens each guest twice behind the scenes: once for video only,
once for audio only. The video side is rendered off-screen and published as NDI.
The audio side is pointed at the playback device and channel you chose.

You drive all of it from one window: a list of guests, live thumbnails proving
each stream is really flowing, live meters proving each guest's audio really
arrived, and per-guest controls.

Two design decisions are worth knowing up front, because they explain how the
app behaves:

- **Nothing is edited in place.** Changing a guest's settings never mutates a
  running piece; ECANDI rebuilds exactly that piece from your saved
  configuration. This is why one change never has side effects on another
  guest.
- **The window is not the show.** Closing the ECANDI console leaves everything
  streaming. Reopen it and you are reconnected to the running session. The
  console can crash without taking your broadcast with it.

---

## What you need

Only one thing is strictly required: **a vdo.ninja link for each guest.**

Beyond that it depends on which half of ECANDI you want. To use the video side
you need something on your network that receives NDI. To separate guests onto
their own audio channels you need a multi-channel virtual audio device; without
one, guests' audio simply plays out your normal playback device, mixed together.
You can use either half on its own.

The **[Quick Start](QUICKSTART.md)** covers this properly, with the exact steps.

---

## Where to go next

| If you want to | Read |
|---|---|
| Get one guest working, start to finish | **[Quick Start](QUICKSTART.md)** |
| Understand every control, indicator, and failure state | **[Operator's Manual](MANUAL.md)** |
| Know what's bundled and under what licence | `NOTICE.md`, beside the application |

---

## A note on names

ECANDI is a fork of **Electron Capture** by Steve Seguin, and is distributed
under the GNU General Public License v3.0.

NDI® is a registered trademark of Vizrt NDI AB. ECANDI is not a product of
Vizrt NDI AB and is not endorsed by them; NDI is named here only to say what
ECANDI is compatible with.
