"""CSV and raw-capture writers.

``RawLogger`` stores the untouched byte stream so a session can be replayed
later through ``file://`` exactly as it arrived. ``CsvLogger`` flattens decoded
positioning frames into one row per frame for analysis in pandas/Excel.
"""

from __future__ import annotations

import csv
import os
import time
from typing import Optional, TextIO

from .protocol import LocFrame

__all__ = ["CsvLogger", "RawLogger", "CSV_COLUMNS"]

CSV_COLUMNS = [
    "host_time", "tag_time", "cmd_type", "cmd_direct",
    "anc_addr16", "tag_addr16", "tag_sn", "tag_mask",
    "a0_angle", "a0_range", "a0_rssi",
    "a1_angle", "a1_range", "a1_rssi",
    "a2_angle", "a2_range", "a2_rssi",
    "a3_angle", "a3_range", "a3_rssi",
    "x_m", "y_m",
    "self_raw_angle", "self_raw_range", "self_raw_degree",
    "angle_360", "angle_dir",
    "battery_v", "dev_type", "lowbattery", "alarm", "chrg", "full",
    "turn_up", "turn_down", "turn_left", "turn_right", "mode", "recal", "lock",
    "acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z",
    "detail_raw",
]


class CsvLogger:
    """One row per positioning frame."""

    def __init__(self, path: str):
        self.path = path
        self._fh: Optional[TextIO] = None
        self._w = None
        self.rows = 0

    def open(self) -> "CsvLogger":
        d = os.path.dirname(os.path.abspath(self.path))
        if d:
            os.makedirs(d, exist_ok=True)
        self._fh = open(self.path, "w", newline="", encoding="utf-8")
        self._w = csv.writer(self._fh)
        self._w.writerow(CSV_COLUMNS)
        return self

    def write(self, f: LocFrame, host_time: Optional[float] = None) -> None:
        if self._w is None:
            raise RuntimeError("logger not open")
        d = f.detail
        xy = f.xy()
        row = [
            f"{host_time if host_time is not None else time.time():.6f}",
            f.tag_time, f.cmd_type, f.cmd_direct,
            f"0x{f.anc_addr16:04X}", f"0x{f.tag_addr16:04X}", f.tag_sn, f.tag_mask,
        ]
        for i in range(4):
            a = f.anchor(i)
            if a is None:
                row += ["", "", ""]
            else:
                row += [a.angle_deg, a.range_cm, "" if a.rssi is None else a.rssi]
        row += [f"{xy[0]:.4f}" if xy else "", f"{xy[1]:.4f}" if xy else ""]
        row += [f.self_raw_angle, f.self_raw_range, f.self_raw_degree,
                f.angle_360, f.angle_dir]
        row += [f"{d.battery_v:.2f}", d.dev_type_name,
                int(d.is_lowbattery), int(d.is_alarm), int(d.is_chrg), int(d.is_tdby),
                int(d.turn_up), int(d.turn_down), int(d.turn_left), int(d.turn_right),
                d.mode, int(d.recal), int(d.lock)]
        row += list(f.acc) + list(f.gyro)
        row += [f"0x{d.raw:08X}"]
        self._w.writerow(row)
        self.rows += 1

    def flush(self) -> None:
        if self._fh:
            self._fh.flush()

    def close(self) -> None:
        if self._fh:
            try:
                self._fh.close()
            finally:
                self._fh = None
                self._w = None

    def __enter__(self):
        return self.open()

    def __exit__(self, *exc):
        self.close()
        return False


class RawLogger:
    """Byte-for-byte capture, replayable via ``file://``."""

    def __init__(self, path: str):
        self.path = path
        self._fh = None
        self.bytes_written = 0

    def open(self) -> "RawLogger":
        d = os.path.dirname(os.path.abspath(self.path))
        if d:
            os.makedirs(d, exist_ok=True)
        self._fh = open(self.path, "wb")
        return self

    def write(self, data: bytes) -> None:
        if self._fh is None:
            raise RuntimeError("logger not open")
        self._fh.write(data)
        self.bytes_written += len(data)

    def flush(self) -> None:
        if self._fh:
            self._fh.flush()

    def close(self) -> None:
        if self._fh:
            try:
                self._fh.close()
            finally:
                self._fh = None

    def __enter__(self):
        return self.open()

    def __exit__(self, *exc):
        self.close()
        return False
