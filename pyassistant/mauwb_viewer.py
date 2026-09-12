#!/usr/bin/env python3
"""
mauwb_viewer.py -- live position viewer for Jiuling/Makerfabs MaUWB_AOA anchors.

An open replacement for the plotting half of MaUWB_Assistant(v3.66).exe.

Two panels share one anchor-centred frame:

  left   a polar sweep -- what the anchor actually measures (angle, range)
  right  the same tags in Cartesian metres, with a fading trail per tag

A reader thread owns the transport so the GUI never blocks on serial I/O; the
animation callback drains a queue. Every tag is direct-labelled with its short
address, so identity never depends on colour alone.

Examples
--------
  python mauwb_viewer.py COM7
  python mauwb_viewer.py /dev/ttyUSB0 -b 921600 --range 12
  python mauwb_viewer.py file://run.bin --loop
  python mauwb_viewer.py tcp://192.168.1.50:8888 --csv live.csv
"""

from __future__ import annotations

import argparse
import collections
import math
import queue
import sys
import threading
import time
from typing import Dict, Optional

from mauwb import theme
from mauwb.logging_ import CsvLogger
from mauwb.protocol import LocFrame
from mauwb.stream import FrameStream
from mauwb.transport import open_transport


#: Per-slot label offsets, so tags that sit close together stay readable.
_LABEL_OFFSETS = [(11, 9), (11, -17), (-11, 9), (-11, -17)]


class TagTrack:
    """Rolling history for one tag."""

    __slots__ = ("addr", "slot", "xs", "ys", "angles", "ranges", "last", "frame", "count")

    def __init__(self, addr: int, slot: int, trail: int):
        self.addr = addr
        self.slot = slot
        self.xs = collections.deque(maxlen=trail)
        self.ys = collections.deque(maxlen=trail)
        self.angles = collections.deque(maxlen=trail)
        self.ranges = collections.deque(maxlen=trail)
        self.last = 0.0
        self.frame: Optional[LocFrame] = None
        self.count = 0

    @property
    def color(self) -> str:
        return theme.series_color(self.slot)

    def push(self, f: LocFrame) -> bool:
        a = f.primary()
        if a is None:
            return False
        x, y = a.xy()
        self.xs.append(x)
        self.ys.append(y)
        self.angles.append(math.radians(a.angle_deg))
        self.ranges.append(a.range_m)
        self.last = time.time()
        self.frame = f
        self.count += 1
        return True


class Reader(threading.Thread):
    """Owns the transport; pushes decoded positioning frames onto a queue."""

    daemon = True

    def __init__(self, spec: str, baud: int, q: "queue.Queue", speed: float, loop: bool):
        super().__init__(name="mauwb-reader")
        self.spec = spec
        self.baud = baud
        self.q = q
        self.speed = speed
        self.loop = loop
        self.stop_flag = threading.Event()
        self.stream = FrameStream()
        self.error: Optional[str] = None
        self.bytes_read = 0

    def run(self) -> None:
        try:
            tr = open_transport(self.spec, baudrate=self.baud,
                                speed=self.speed, loop=self.loop)
            tr.open()
        except Exception as e:
            self.error = f"cannot open {self.spec}: {e}"
            return
        try:
            while not self.stop_flag.is_set():
                try:
                    data = tr.read(4096)
                except Exception as e:
                    self.error = f"read failed: {e}"
                    break
                if data:
                    self.bytes_read += len(data)
                    for f in self.stream.feed(data):
                        if isinstance(f, LocFrame):
                            try:
                                self.q.put_nowait(f)
                            except queue.Full:
                                pass
                elif tr.eof:
                    break
        finally:
            tr.close()

    def stop(self) -> None:
        self.stop_flag.set()


def _fit_wedge(fig, ax, rect, fov: float) -> None:
    """Size a partial polar axes so its visible wedge fills ``rect``.

    A polar axes inscribes the whole circle in the box it is given and only then
    clips to ``thetamin..thetamax``, so a +/-90 wedge handed a panel-sized box
    comes out half-width with the unused lower half of the disc eating the panel.
    The exact placement rule has changed between matplotlib versions, so rather
    than hard-code it this measures it: draw once with a provisional square box,
    read back where the pole and the apex actually landed, then solve for the
    box that puts the wedge where we want it.
    """
    import math as _m

    x0, y0, w, h = rect
    fw, fh = fig.get_size_inches()
    pw, ph = w * fw, h * fh                     # panel size, inches

    # --- measure: one square box of known side -> where do pole and apex go?
    s0 = pw                                     # provisional side, inches
    ax.set_position([x0, y0, s0 / fw, s0 / fh])
    fig.canvas.draw()

    inv = fig.transFigure.inverted()
    rmax = ax.get_ylim()[1] or 1.0

    def at(theta_deg, r):
        pt = ax.transData.transform((_m.radians(theta_deg), r))
        fx, fy = inv.transform(pt)
        return fx * fw, fy * fh                 # figure coords, inches

    cx, cy = at(0.0, 0.0)                       # the pole
    _, ay = at(0.0, rmax)                       # the apex, straight up
    r0 = abs(ay - cy)
    if r0 <= 0:
        return                                  # degenerate; leave as placed

    # Ratios of radius and pole position to the box side (linear in the side).
    k_r = r0 / s0
    k_x = (cx - x0 * fw) / s0
    k_y = (cy - y0 * fh) / s0

    # --- solve: largest wedge that fits the panel, centred in it
    f = min(max(fov, 1.0), 90.0)
    half_w = _m.sin(_m.radians(f))              # visible half-width, in units of r
    r_t = min(pw / (2.0 * half_w), ph)
    side = r_t / k_r

    box_x = (x0 * fw + pw / 2.0) - k_x * side
    box_y = (y0 * fh + (ph - r_t) / 2.0) - k_y * side

    ax.set_position([box_x / fw, box_y / fh, side / fw, side / fh])


def run(args) -> int:
    try:
        import matplotlib
        import matplotlib.pyplot as plt
        from matplotlib.animation import FuncAnimation
    except ImportError:
        print("matplotlib is required for the viewer: pip install matplotlib",
              file=sys.stderr)
        return 2

    theme.apply(plt)

    q: "queue.Queue" = queue.Queue(maxsize=4096)
    reader = Reader(args.port, args.baud, q, args.speed, args.loop)
    reader.start()

    csv_log = CsvLogger(args.csv).open() if args.csv else None

    tracks: Dict[int, TagTrack] = {}
    next_slot = [0]
    rate = collections.deque(maxlen=120)

    fig = plt.figure(figsize=(12.6, 4.4))
    fig.canvas.manager.set_window_title(f"MaUWB AOA viewer - {args.port}")

    # Both panels are 2:1 -- a +/-90 polar wedge is a half disc, and the
    # Cartesian panel spans 2*range horizontally by range vertically.
    PANEL_L = (0.045, 0.10, 0.44, 0.76)
    PANEL_R = (0.555, 0.10, 0.42, 0.76)

    # add_axes, not add_subplot: an axes carrying a SubplotSpec has its box
    # recomputed from that spec during aspect handling, which would undo
    # the placement _fit_wedge makes below.
    ax_p = fig.add_axes(PANEL_L, projection="polar")
    ax_p.set_theta_zero_location("N")
    ax_p.set_theta_direction(-1)          # positive angle to the right
    ax_p.set_thetamin(-args.fov)
    ax_p.set_thetamax(args.fov)
    ax_p.set_ylim(0, args.range)
    # Radial labels ride inside the wedge, clear of the flat edge.
    ax_p.set_rlabel_position(-args.fov * 0.82)
    ax_p.tick_params(colors=theme.MUTED, labelsize=8)
    _fit_wedge(fig, ax_p, PANEL_L, args.fov)

    ax_c = fig.add_axes(PANEL_R)
    ax_c.set_aspect("equal", adjustable="box")
    ax_c.set_xlim(-args.range, args.range)
    ax_c.set_ylim(-0.6, args.range)
    ax_c.set_xlabel("x  (m)", labelpad=2)
    ax_c.set_ylabel("y  (m)", labelpad=2)
    ax_c.tick_params(labelsize=8)
    for side in ("top", "right"):
        ax_c.spines[side].set_visible(False)

    # The anchor sits at the origin of the Cartesian panel.
    ax_c.plot([0], [0], marker="^", markersize=10, color=theme.INK_2,
              linestyle="none", zorder=5)
    ax_c.annotate("anchor", (0, 0), textcoords="offset points", xytext=(0, -14),
                  ha="center", va="top", color=theme.MUTED, fontsize=7.5)

    # Titles live in figure coords: _fit_wedge pushes the polar box past the top
    # of the figure, so an axes-anchored title on that panel would be clipped.
    _TITLE_Y = 0.885
    for _rect, _txt in ((PANEL_L, "anchor view  (angle, range)"),
                        (PANEL_R, "position  (metres from anchor)")):
        fig.text(_rect[0] + _rect[2] / 2.0, _TITLE_Y, _txt, ha="center",
                 va="bottom", color=theme.INK, fontsize=10, fontweight="600")

    status = fig.text(0.045, 0.945, "waiting for data...", color=theme.INK_2,
                      fontsize=9, va="center")
    subtitle = fig.text(0.975, 0.945, "", color=theme.MUTED, fontsize=8,
                        va="center", ha="right")

    artists: Dict[int, dict] = {}

    def artists_for(tr: TagTrack) -> dict:
        if tr.addr in artists:
            return artists[tr.addr]
        c = tr.color
        a = {
            # polar
            "p_trail": ax_p.plot([], [], color=c, linewidth=1.2, alpha=0.35,
                                 solid_capstyle="round")[0],
            "p_head": ax_p.plot([], [], color=c, marker="o", markersize=9,
                                linestyle="none", markeredgecolor=theme.SURFACE,
                                markeredgewidth=2, zorder=6)[0],
            # cartesian
            "c_trail": ax_c.plot([], [], color=c, linewidth=1.2, alpha=0.35,
                                 solid_capstyle="round")[0],
            "c_head": ax_c.plot([], [], color=c, marker="o", markersize=9,
                                linestyle="none", markeredgecolor=theme.SURFACE,
                                markeredgewidth=2, zorder=6)[0],
            "label": ax_c.annotate("", (0, 0), textcoords="offset points",
                                   xytext=_LABEL_OFFSETS[tr.slot % 4],
                                   color=theme.INK, fontsize=8,
                                   fontweight="600", zorder=7),
        }
        artists[tr.addr] = a
        return a

    def update(_frame):
        drained = 0
        now = time.time()
        while True:
            try:
                f = q.get_nowait()
            except queue.Empty:
                break
            drained += 1
            if args.tag is not None and f.tag_addr16 != args.tag:
                continue
            tr = tracks.get(f.tag_addr16)
            if tr is None:
                tr = TagTrack(f.tag_addr16, next_slot[0], args.trail)
                next_slot[0] += 1
                tracks[f.tag_addr16] = tr
            tr.push(f)
            if csv_log:
                csv_log.write(f)
        rate.append((now, drained))

        changed = []
        for tr in tracks.values():
            a = artists_for(tr)
            stale = (now - tr.last) > args.timeout
            alpha = 0.25 if stale else 1.0

            a["p_trail"].set_data(list(tr.angles), list(tr.ranges))
            a["c_trail"].set_data(list(tr.xs), list(tr.ys))
            if tr.xs:
                a["p_head"].set_data([tr.angles[-1]], [tr.ranges[-1]])
                a["c_head"].set_data([tr.xs[-1]], [tr.ys[-1]])
                a["label"].xy = (tr.xs[-1], tr.ys[-1])
                d = tr.frame.detail if tr.frame else None
                txt = f"0x{tr.addr:04X}"
                if d is not None:
                    txt += f"  {d.battery_v:.2f}V"
                    fl = d.flags()
                    if "ALARM" in fl:
                        txt += "  ALARM"
                    elif d.is_lowbattery:
                        txt += "  LOW"
                a["label"].set_text(txt)
                a["label"].set_ha("right" if tr.slot % 4 >= 2 else "left")
                a["label"].set_color(theme.STATUS["critical"] if (
                    d is not None and (d.is_alarm or d.is_lowbattery)) else theme.INK)
            for k in ("p_head", "c_head", "p_trail", "c_trail", "label"):
                a[k].set_alpha(alpha if k.endswith("head") or k == "label"
                               else alpha * 0.35)
            changed += list(a.values())

        # status line
        if reader.error:
            status.set_text(reader.error)
            status.set_color(theme.STATUS["critical"])
        else:
            window = [n for t, n in rate if now - t <= 2.0]
            fps = sum(window) / 2.0 if window else 0.0
            live = sum(1 for t in tracks.values() if now - t.last <= args.timeout)
            status.set_text(
                f"{reader.stream.stats.frames} frames   {fps:5.1f} loc/s   "
                f"{live}/{len(tracks)} tags live"
            )
            status.set_color(theme.INK_2)
        subtitle.set_text(
            f"{args.port}   bad_crc={reader.stream.stats.bad_checksum}  "
            f"resync={reader.stream.stats.resyncs}"
        )
        changed += [status, subtitle]

        if tracks and len(tracks) > 1:
            handles = [artists_for(t)["c_head"] for t in tracks.values()]
            labels = [f"0x{t.addr:04X}" for t in tracks.values()]
            ax_c.legend(handles, labels, loc="upper right", fontsize=8,
                        labelcolor=theme.INK_2, handletextpad=0.4)

        return changed

    anim = FuncAnimation(fig, update, interval=args.interval, blit=False,
                         cache_frame_data=False)

    try:
        plt.show()
    finally:
        reader.stop()
        reader.join(timeout=1.0)
        if csv_log:
            csv_log.close()
            print(f"wrote {csv_log.rows} rows to {args.csv}", file=sys.stderr)

    if reader.error:
        print(f"error: {reader.error}", file=sys.stderr)
        return 2
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="mauwb_viewer.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("port", help="COM7 | /dev/ttyUSB0 | tcp://host:port | file://cap.bin")
    p.add_argument("-b", "--baud", type=int, default=115200)
    p.add_argument("--range", type=float, default=10.0, help="plot radius in metres")
    p.add_argument("--fov", type=float, default=90.0, help="polar half-angle in degrees")
    p.add_argument("--trail", type=int, default=120, help="trail length in samples")
    p.add_argument("--interval", type=int, default=50, help="redraw period in ms")
    p.add_argument("--timeout", type=float, default=2.0,
                   help="seconds before a tag is dimmed as stale")
    p.add_argument("--tag", type=lambda s: int(s, 0), help="only this tag short address")
    p.add_argument("--csv", help="also log decoded frames to CSV")
    p.add_argument("--speed", type=float, default=1.0, help="file:// replay speed")
    p.add_argument("--loop", action="store_true", help="file:// replay repeatedly")
    args = p.parse_args(argv)
    try:
        return run(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
