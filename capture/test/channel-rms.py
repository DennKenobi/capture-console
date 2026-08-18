# WASAPI loopback per-channel RMS probe — Capture Console test tooling.
# Verifies audio-plane channel placement without touching the X32 (its local stand-in).
#   python capture/test/channel-rms.py --list
#   python capture/test/channel-rms.py --device-match "VBMatrix In 1" --seconds 3 [--json]
# Requires: pip install pyaudiowpatch
import argparse
import json
import math
import struct
import sys

import pyaudiowpatch as pyaudio


def loopback_devices(p):
    return list(p.get_loopback_device_info_generator())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--device-match", default="")
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    p = pyaudio.PyAudio()
    try:
        devs = loopback_devices(p)
        if args.list:
            for d in devs:
                print(f"[{d['index']:3d}] ch={int(d['maxInputChannels'])} sr={int(d['defaultSampleRate'])} {d['name']}")
            return 0

        needle = args.device_match.lower()
        target = next((d for d in devs if needle in d["name"].lower()), None)
        if not target:
            print(f"no loopback device matching '{args.device_match}'", file=sys.stderr)
            return 1

        ch = int(target["maxInputChannels"])
        sr = int(target["defaultSampleRate"])
        frames_per_buffer = 2048
        stream = p.open(format=pyaudio.paFloat32, channels=ch, rate=sr, input=True,
                        input_device_index=target["index"], frames_per_buffer=frames_per_buffer)
        sums = [0.0] * ch
        count = 0
        need = int(sr * args.seconds)
        while count < need:
            data = stream.read(frames_per_buffer, exception_on_overflow=False)
            n = len(data) // 4
            samples = struct.unpack(f"{n}f", data)
            frames = n // ch
            for f in range(frames):
                for c in range(ch):
                    v = samples[f * ch + c]
                    sums[c] += v * v
            count += frames
        stream.stop_stream()
        stream.close()

        rms = [math.sqrt(s / max(count, 1)) for s in sums]
        result = {"device": target["name"], "channels": ch, "sampleRate": sr,
                  "seconds": args.seconds, "rms": [round(v, 5) for v in rms]}
        if args.json:
            print(json.dumps(result))
        else:
            print(f"{target['name']} ({ch}ch @ {sr})")
            for i, v in enumerate(rms):
                bar = "#" * min(60, int(v * 300))
                print(f"  ch{i + 1}: {v:.5f} {bar}")
        return 0
    finally:
        p.terminate()


if __name__ == "__main__":
    sys.exit(main())
