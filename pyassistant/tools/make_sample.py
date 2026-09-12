#!/usr/bin/env python3
"""Generate a synthetic raw capture so the tools can be exercised without hardware.

    python tools/make_sample.py samples/demo.bin --tags 3 --seconds 20

The result is byte-compatible with a real capture, so it replays through
``file://`` in both mauwb_cli.py and mauwb_viewer.py.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from mauwb.protocol import CmdDirect, CmdType, TagDetail, build_frame


def loc_payload(tag_time: int, anc16: int, tag16: int, sn: int, mask: int,
                anchors, detail: int, raw_angle: int, raw_range: int,
                angle_360: int, angle_dir: int) -> bytes:
    """Build the bytes that follow cmd_direct in a plain LOC frame."""
    b = bytearray()
    b += struct.pack("<IHHBB", tag_time, anc16, tag16, sn, mask)
    for angle, rng in anchors:
        b += struct.pack("<hH", angle, rng)
    b += struct.pack("<I", detail)
    b += struct.pack("<HHH", 0, 0, 0)       # acc
    b += struct.pack("<HHH", 0, 0, 0)       # gyro
    b += struct.pack("<hHi", raw_angle, raw_range, 0)
    b += struct.pack("<HB", angle_360, angle_dir)
    b += b"\x00" * 5                        # reserve
    return bytes(b)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("out")
    p.add_argument("--tags", type=int, default=3, help="number of tags to simulate")
    p.add_argument("--seconds", type=float, default=20.0)
    p.add_argument("--rate", type=float, default=20.0, help="frames per second per tag")
    p.add_argument("--noise", type=float, default=1.5, help="angle noise, degrees")
    p.add_argument("--garbage", action="store_true",
                   help="inject junk bytes to exercise the resync path")
    p.add_argument("--seed", type=int, default=7)
    args = p.parse_args(argv)

    rnd = random.Random(args.seed)
    n = int(args.seconds * args.rate)

    # Each tag walks its own smooth path so trails look like real motion.
    paths = []
    for i in range(args.tags):
        paths.append({
            "addr": 0x1000 + 0x54F * i,
            "phase": rnd.uniform(0, math.tau),
            "sweep": rnd.uniform(35, 70),          # degrees of arc
            "r0": rnd.uniform(1.5, 4.0),
            "dr": rnd.uniform(0.5, 2.0),
            "period": rnd.uniform(6.0, 13.0),
            "batt": rnd.randint(360, 415),
            "dev": rnd.choice([0, 1, 2]),
        })

    d = os.path.dirname(os.path.abspath(args.out))
    if d:
        os.makedirs(d, exist_ok=True)

    written = 0
    with open(args.out, "wb") as fh:
        for k in range(n):
            t = k / args.rate
            for i, pa in enumerate(paths):
                w = math.tau * t / pa["period"] + pa["phase"]
                angle = pa["sweep"] * math.sin(w) + rnd.gauss(0, args.noise)
                rng_m = pa["r0"] + pa["dr"] * math.sin(w * 0.7)
                rng_cm = max(10, int(rng_m * 100 + rnd.gauss(0, 3)))
                ai = int(round(angle))

                det = TagDetail(
                    battery_val=pa["batt"],
                    dev_type=pa["dev"],
                    is_chrg=False,
                    is_lowbattery=pa["batt"] < 370,
                    is_alarm=(i == 0 and 0.45 < (t % 10) / 10 < 0.55),
                ).to_u32()

                payload = loc_payload(
                    tag_time=int(t * 1000),
                    anc16=0x0000,
                    tag16=pa["addr"] & 0xFFFF,
                    sn=k & 0xFF,
                    mask=0x01,
                    anchors=[(ai, rng_cm), (0, 0), (0, 0), (0, 0)],
                    detail=det,
                    raw_angle=ai,
                    raw_range=rng_cm,
                    angle_360=int((angle + 360) % 360),
                    angle_dir=int(((angle + 360) % 360) // 45),
                )
                frame = build_frame(CmdType.LOC, payload,
                                    saddr=0xDDDDDDDDDDDDDDDD,
                                    daddr=0xEEEEEEEEEEEEEEEE,
                                    cmd_direct=CmdDirect.ENGINE_REPORT)
                if args.garbage and rnd.random() < 0.01:
                    fh.write(bytes(rnd.randrange(256) for _ in range(rnd.randint(1, 9))))
                fh.write(frame)
                written += 1

    size = os.path.getsize(args.out)
    print(f"wrote {written} frames ({size} bytes) to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
