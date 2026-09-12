#!/usr/bin/env python3
"""
mauwb_cli.py -- console tool for Jiuling/Makerfabs MaUWB_AOA anchors.

An open replacement for the console half of MaUWB_Assistant(v3.66).exe.

Subcommands
-----------
  ports     list serial ports
  sniff     decode frames live (optionally logging CSV and/or raw bytes)
  send      send a config command and print replies
  replay    decode a previously captured raw file
  decode    decode a single frame given as hex on the command line

Examples
--------
  python mauwb_cli.py ports
  python mauwb_cli.py sniff COM7
  python mauwb_cli.py sniff /dev/ttyUSB0 -b 921600 --csv run.csv --raw run.bin
  python mauwb_cli.py sniff tcp://192.168.1.50:8888 --hex
  python mauwb_cli.py send COM7 anchor getcfg
  python mauwb_cli.py send COM7 anchor setcfg 1 1 1111 1
  python mauwb_cli.py replay run.bin --stats
  python mauwb_cli.py decode 2A4C00DD...23
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Optional

from mauwb import commands, protocol
from mauwb.logging_ import CsvLogger, RawLogger
from mauwb.protocol import CmdType, ConfigFrame, LocFrame, RawFrame
from mauwb.stream import FrameStream, iter_frames
from mauwb.transport import list_serial_ports, open_transport


# --------------------------------------------------------------------------
# rendering helpers
# --------------------------------------------------------------------------

def fmt_frame(f, show_hex: bool = False) -> str:
    if isinstance(f, LocFrame):
        line = f"[{f.type_name:8}] {f.summary()}"
    elif isinstance(f, ConfigFrame):
        line = f"[{f.type_name:8}] {f.direct_name:<13} {f.text!r}"
    else:
        line = f"[{f.type_name:8}] {f.summary()}"
    if show_hex:
        line += "\n           " + f.raw.hex(" ")
    return line


def _install_sigint(state: dict) -> None:
    import signal

    def handler(signum, frame):
        state["stop"] = True

    try:
        signal.signal(signal.SIGINT, handler)
    except (ValueError, OSError):
        pass


# --------------------------------------------------------------------------
# subcommands
# --------------------------------------------------------------------------

def cmd_ports(args) -> int:
    ports = list_serial_ports()
    if not ports:
        print("No serial ports found. (Is pyserial installed? Is the anchor plugged in?)")
        return 1
    width = max(len(d) for d, _, _ in ports)
    for dev, desc, hwid in ports:
        print(f"{dev:<{width}}  {desc}")
        if args.verbose:
            print(f"{'':<{width}}  {hwid}")
    return 0


def cmd_sniff(args) -> int:
    state = {"stop": False}
    _install_sigint(state)

    tr = open_transport(args.port, baudrate=args.baud, speed=args.speed, loop=args.loop)
    stream = FrameStream(verify=not args.no_verify)

    csv_log = CsvLogger(args.csv).open() if args.csv else None
    raw_log = RawLogger(args.raw).open() if args.raw else None

    started = time.time()
    last_report = started
    shown = 0
    loc_count = 0

    print(f"# listening on {tr.name}  (Ctrl-C to stop)", file=sys.stderr)
    if args.tag is not None:
        print(f"# filtering tag 0x{args.tag:04X}", file=sys.stderr)

    try:
        tr.open()
    except Exception as e:
        print(f"error: cannot open {args.port}: {e}", file=sys.stderr)
        return 2

    try:
        while not state["stop"]:
            try:
                data = tr.read(4096)
            except Exception as e:
                print(f"error: read failed: {e}", file=sys.stderr)
                break

            if data:
                if raw_log:
                    raw_log.write(data)
                for f in stream.feed(data):
                    if args.type and f.type_name not in args.type:
                        continue
                    if isinstance(f, LocFrame):
                        if args.tag is not None and f.tag_addr16 != args.tag:
                            continue
                        loc_count += 1
                        if csv_log:
                            csv_log.write(f)
                    if not args.quiet:
                        print(fmt_frame(f, args.hex))
                    shown += 1
                    if args.count and shown >= args.count:
                        state["stop"] = True
                        break
            elif tr.eof:
                break

            now = time.time()
            if args.stats and now - last_report >= 1.0:
                el = now - started
                print(f"# {stream.stats} | {loc_count/el:6.1f} loc/s", file=sys.stderr)
                last_report = now
                if csv_log:
                    csv_log.flush()
                if raw_log:
                    raw_log.flush()
    finally:
        tr.close()
        if csv_log:
            csv_log.close()
        if raw_log:
            raw_log.close()

    el = max(time.time() - started, 1e-9)
    print(f"\n# {stream.stats} in {el:.1f}s ({loc_count/el:.1f} loc/s)", file=sys.stderr)
    if csv_log:
        print(f"# wrote {csv_log.rows} rows to {args.csv}", file=sys.stderr)
    if raw_log:
        print(f"# wrote {raw_log.bytes_written} bytes to {args.raw}", file=sys.stderr)
    return 0


def cmd_send(args) -> int:
    sets = {
        "anchor": (commands.Anchor, CmdType.ANCHOR_CFG),
        "tag": (commands.Tag, CmdType.TAG_CFG),
        "robot": (commands.Robot, CmdType.ROBOT_CFG),
    }
    cls, ctype = sets[args.target]
    cs = cls(saddr=args.saddr, daddr=args.daddr)

    text = " ".join(args.command)
    frame = cs.raw(text)

    print(f"-> {args.target}: {text!r}")
    print(f"   {frame.hex(' ')}")
    if args.dry_run:
        return 0

    tr = open_transport(args.port, baudrate=args.baud)
    try:
        tr.open()
    except Exception as e:
        print(f"error: cannot open {args.port}: {e}", file=sys.stderr)
        return 2

    stream = FrameStream()
    try:
        tr.write(frame)
        deadline = time.time() + args.wait
        got = 0
        while time.time() < deadline:
            data = tr.read(4096)
            if not data:
                if tr.eof:
                    break
                continue
            for f in stream.feed(data):
                # positioning frames stream continuously; only show replies
                if isinstance(f, LocFrame) and not args.all:
                    continue
                print(f"<- {fmt_frame(f, args.hex)}")
                got += 1
        if got == 0:
            print("   (no reply within timeout)", file=sys.stderr)
    finally:
        tr.close()
    return 0


def cmd_replay(args) -> int:
    with open(args.file, "rb") as fh:
        blob = fh.read()

    stream = FrameStream(verify=not args.no_verify)
    csv_log = CsvLogger(args.csv).open() if args.csv else None
    n = 0
    types: dict = {}
    tags: dict = {}

    for f in stream.feed_iter(blob):
        types[f.type_name] = types.get(f.type_name, 0) + 1
        if isinstance(f, LocFrame):
            tags[f.tag_addr16] = tags.get(f.tag_addr16, 0) + 1
            if args.tag is not None and f.tag_addr16 != args.tag:
                continue
            if csv_log:
                csv_log.write(f)
        if not args.quiet:
            print(fmt_frame(f, args.hex))
        n += 1

    if csv_log:
        csv_log.close()

    if args.stats or args.quiet:
        print(f"# {len(blob)} bytes -> {stream.stats}", file=sys.stderr)
        for t, c in sorted(types.items(), key=lambda kv: -kv[1]):
            print(f"#   {t:10} {c}", file=sys.stderr)
        if tags:
            print("#   tags seen: " + ", ".join(
                f"0x{t:04X}({c})" for t, c in sorted(tags.items(), key=lambda kv: -kv[1])
            ), file=sys.stderr)
        if csv_log:
            print(f"# wrote {csv_log.rows} rows to {args.csv}", file=sys.stderr)
    return 0


def cmd_decode(args) -> int:
    text = "".join(args.hexbytes).replace(",", " ").replace("0x", "")
    try:
        blob = bytes.fromhex(text.replace(" ", ""))
    except ValueError as e:
        print(f"error: not valid hex: {e}", file=sys.stderr)
        return 2

    found = 0
    for f in iter_frames(blob, verify=not args.no_verify):
        found += 1
        print(fmt_frame(f, show_hex=True))
        if isinstance(f, LocFrame):
            print(f"    tag_time      {f.tag_time}")
            print(f"    anchor/tag    0x{f.anc_addr16:04X} / 0x{f.tag_addr16:04X}"
                  f"  sn={f.tag_sn} mask=0x{f.tag_mask:02X}")
            for a in f.anchors:
                mark = " " if a.valid else "-"
                print(f"   {mark}{a}")
            xy = f.xy()
            if xy:
                print(f"    position      x={xy[0]:+.3f} m  y={xy[1]:+.3f} m")
            print(f"    self raw      {f.self_raw_angle:+d} deg / {f.self_raw_range} cm"
                  f"  degree={f.self_raw_degree}")
            print(f"    angle_360     {f.angle_360} (dir {f.angle_dir})")
            d = f.detail
            print(f"    battery       {d.battery_v:.2f} V  ({d.dev_type_name})")
            print(f"    detail        0x{d.raw:08X}  flags={d.flags() or '-'}")
            print(f"    acc/gyro      {f.acc} / {f.gyro}")
    if not found:
        print("no complete frame found in input", file=sys.stderr)
        return 1
    return 0


# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="mauwb_cli.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("ports", help="list serial ports")
    sp.add_argument("-v", "--verbose", action="store_true", help="show hardware IDs")
    sp.set_defaults(func=cmd_ports)

    sp = sub.add_parser("sniff", help="decode frames live")
    sp.add_argument("port", help="COM7 | /dev/ttyUSB0 | tcp://host:port | file://cap.bin")
    sp.add_argument("-b", "--baud", type=int, default=115200)
    sp.add_argument("--csv", help="write decoded positioning frames to this CSV")
    sp.add_argument("--raw", help="write the raw byte stream here (replayable)")
    sp.add_argument("--hex", action="store_true", help="also dump frame bytes")
    sp.add_argument("--tag", type=lambda s: int(s, 0), help="only this tag short address")
    sp.add_argument("--type", action="append",
                    help="only these frame types (repeatable), e.g. --type LOC")
    sp.add_argument("-n", "--count", type=int, help="stop after N frames")
    sp.add_argument("-q", "--quiet", action="store_true", help="suppress per-frame output")
    sp.add_argument("--stats", action="store_true", help="print a rate line every second")
    sp.add_argument("--no-verify", action="store_true", help="accept bad checksums")
    sp.add_argument("--speed", type=float, default=1.0, help="file:// replay speed")
    sp.add_argument("--loop", action="store_true", help="file:// replay repeatedly")
    sp.set_defaults(func=cmd_sniff)

    sp = sub.add_parser("send", help="send a config command")
    sp.add_argument("port")
    sp.add_argument("target", choices=["anchor", "tag", "robot"])
    sp.add_argument("command", nargs="+", help="e.g. getcfg | setcfg 1 1 1111 1 100 1 0")
    sp.add_argument("-b", "--baud", type=int, default=115200)
    sp.add_argument("--saddr", type=lambda s: int(s, 0), default=0)
    sp.add_argument("--daddr", type=lambda s: int(s, 0), default=0)
    sp.add_argument("-w", "--wait", type=float, default=2.0, help="seconds to wait for a reply")
    sp.add_argument("--all", action="store_true", help="also show positioning frames")
    sp.add_argument("--hex", action="store_true")
    sp.add_argument("--dry-run", action="store_true", help="print the frame, do not send")
    sp.set_defaults(func=cmd_send)

    sp = sub.add_parser("replay", help="decode a raw capture file")
    sp.add_argument("file")
    sp.add_argument("--csv", help="write decoded positioning frames to this CSV")
    sp.add_argument("--tag", type=lambda s: int(s, 0))
    sp.add_argument("--hex", action="store_true")
    sp.add_argument("-q", "--quiet", action="store_true")
    sp.add_argument("--stats", action="store_true")
    sp.add_argument("--no-verify", action="store_true")
    sp.set_defaults(func=cmd_replay)

    sp = sub.add_parser("decode", help="decode one frame from hex")
    sp.add_argument("hexbytes", nargs="+", help="hex bytes, spaces optional")
    sp.add_argument("--no-verify", action="store_true")
    sp.set_defaults(func=cmd_decode)

    return p


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
