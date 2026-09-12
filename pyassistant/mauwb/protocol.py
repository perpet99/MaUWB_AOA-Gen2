"""
Jiuling (久凌电子) AOA UWB serial protocol - frame definitions, parsing and building.

Reference
---------
"久凌 AOA 通信协议" -- 久凌(温州)电子科技有限公司, rev 2025-03-24.
Shipped as ``d3b51756734822.pdf`` inside ``MaUWB_AOA_Assistant.zip``.

All multi-byte fields are little-endian ("低位在前").

Frame envelope (common to every frame type)::

    off  size  field
    0    1     head        0x2A
    1    2     cmd_len     length of bytes[3 : 3+cmd_len]
    3    8     cmd_saddr   own long address
    11   8     cmd_daddr   peer long address
    19   1     cmd_type
    20   1     cmd_direct
    21   *     payload
    *    1     check       XOR of bytes[3 : 3+cmd_len]
    *    1     foot        0x23

Total frame size is therefore ``cmd_len + 5``.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import List, Optional, Union

__all__ = [
    "HEAD", "FOOT", "CmdType", "CmdDirect",
    "xor_crc", "AnchorMeas", "TagDetail", "LocFrame", "ConfigFrame", "RawFrame",
    "Frame", "FrameError", "parse_frame", "build_frame", "build_config_frame",
    "LOC_LEN", "LOC_RSSI_LEN", "ENVELOPE_EXTRA",
]

HEAD = 0x2A
FOOT = 0x23

#: bytes added around the cmd_len-covered region: head(1) + cmd_len(2) + check(1) + foot(1)
ENVELOPE_EXTRA = 5

#: total frame length of a plain positioning frame (cmd_type=1)
LOC_LEN = 81
#: total frame length of a positioning frame carrying RSSI (cmd_type=0x64)
LOC_RSSI_LEN = 89


class CmdType:
    """``cmd_type`` values (byte 19)."""

    LOC = 0x01          # 基站定位帧   - anchor positioning report
    ANCHOR_CFG = 0x02   # 基站配置帧   - anchor config
    TAG_CFG = 0x03      # 标签配置帧   - tag config
    OTA = 0x04          # OTA 升级帧
    ROBOT_CFG = 0x05    # 整机配置帧   - whole-machine (robot) config
    LOC_RSSI = 0x64     # 基站定位帧 RSSI

    NAMES = {
        LOC: "LOC", ANCHOR_CFG: "ANCHOR_CFG", TAG_CFG: "TAG_CFG",
        OTA: "OTA", ROBOT_CFG: "ROBOT_CFG", LOC_RSSI: "LOC_RSSI",
    }

    @classmethod
    def name(cls, v: int) -> str:
        return cls.NAMES.get(v, f"0x{v:02X}")


class CmdDirect:
    """``cmd_direct`` values (byte 20). "engine" == the PC side."""

    ENGINE_REQ = 1      # 引擎请求
    DEV_REPLY = 2       # 设备回复
    DEV_REQ = 3         # 设备请求
    ENGINE_REPLY = 4    # 引擎回复
    ENGINE_REPORT = 5   # 引擎上报
    DEV_REPORT = 6      # 设备上报

    NAMES = {
        ENGINE_REQ: "ENGINE_REQ", DEV_REPLY: "DEV_REPLY", DEV_REQ: "DEV_REQ",
        ENGINE_REPLY: "ENGINE_REPLY", ENGINE_REPORT: "ENGINE_REPORT",
        DEV_REPORT: "DEV_REPORT",
    }

    @classmethod
    def name(cls, v: int) -> str:
        return cls.NAMES.get(v, str(v))


#: 设备类型 - tag_detail_para.dev_type
DEV_TYPE_NAMES = {0: "learn-board", 1: "wristband", 2: "remote"}

#: 360° 大致方向 - angle_dir. The firmware reports a coarse sector index.
#: Kept as a raw int; no sector table is given in the protocol document.


class FrameError(ValueError):
    """Raised when a buffer is not a well-formed frame."""


def xor_crc(data: bytes, offset: int = 0, length: Optional[int] = None) -> int:
    """XOR checksum, per [备注 2：校验计算程式].

    ``check = data[offset] ^ data[offset+1] ^ ... ^ data[offset+length-1]``
    """
    if length is None:
        length = len(data) - offset
    crc = 0
    for b in data[offset:offset + length]:
        crc ^= b
    return crc


@dataclass
class AnchorMeas:
    """One anchor's filtered measurement of a tag."""

    index: int
    angle_deg: int          # int16, degrees, signed
    range_cm: int           # uint16, centimetres
    rssi: Optional[int] = None   # int16, only present in LOC_RSSI frames

    @property
    def valid(self) -> bool:
        """Heuristic: an anchor that never ranged reports 0/0."""
        return not (self.angle_deg == 0 and self.range_cm == 0)

    @property
    def range_m(self) -> float:
        return self.range_cm / 100.0

    def xy(self) -> tuple:
        """Cartesian offset (metres) of the tag relative to this anchor.

        The anchor boresight is +Y; a positive angle is to the right (+X).
        """
        import math
        a = math.radians(self.angle_deg)
        r = self.range_m
        return (r * math.sin(a), r * math.cos(a))

    def __str__(self) -> str:
        s = f"A{self.index}: {self.angle_deg:+4d}deg {self.range_cm:5d}cm"
        if self.rssi is not None:
            s += f" {self.rssi:+5d}dBm"
        return s


@dataclass
class TagDetail:
    """Decoded ``tag_detail_para`` bitfield, per [备注 1：位结构体].

    Bit layout of the uint32 (LSB first, as emitted by a little-endian C bitfield)::

        0      is_lowbattery              1
        1      is_alarm                   1
        2      is_chrg                    1
        3      is_tdby                    1
        4-13   battery_val               10   (350 == 3.50 V)
        14     is_offset_range_zero_bit    1
        15     is_offset_pdoa_zero_bit     1
        16     turn_up                     1   (remote only)
        17     turn_down                   1
        18     turn_left                   1
        19     turn_right                  1
        20-22  mode                        3   (remote only)
        23     recal                       1   (remote only)
        24     lock                        1   (remote only)
        25-27  dev_type                    3   (0 learn-board / 1 wristband / 2 remote)
        28-31  reserve                     4
    """

    raw: int = 0
    is_lowbattery: bool = False
    is_alarm: bool = False
    is_chrg: bool = False
    is_tdby: bool = False
    battery_val: int = 0            # raw, hundredths of a volt
    is_offset_range_zero: bool = False
    is_offset_pdoa_zero: bool = False
    turn_up: bool = False
    turn_down: bool = False
    turn_left: bool = False
    turn_right: bool = False
    mode: int = 0
    recal: bool = False
    lock: bool = False
    dev_type: int = 0
    reserve: int = 0

    @classmethod
    def from_u32(cls, v: int) -> "TagDetail":
        b = lambda shift: bool((v >> shift) & 1)
        return cls(
            raw=v,
            is_lowbattery=b(0),
            is_alarm=b(1),
            is_chrg=b(2),
            is_tdby=b(3),
            battery_val=(v >> 4) & 0x3FF,
            is_offset_range_zero=b(14),
            is_offset_pdoa_zero=b(15),
            turn_up=b(16),
            turn_down=b(17),
            turn_left=b(18),
            turn_right=b(19),
            mode=(v >> 20) & 0x7,
            recal=b(23),
            lock=b(24),
            dev_type=(v >> 25) & 0x7,
            reserve=(v >> 28) & 0xF,
        )

    def to_u32(self) -> int:
        v = 0
        v |= int(self.is_lowbattery) << 0
        v |= int(self.is_alarm) << 1
        v |= int(self.is_chrg) << 2
        v |= int(self.is_tdby) << 3
        v |= (self.battery_val & 0x3FF) << 4
        v |= int(self.is_offset_range_zero) << 14
        v |= int(self.is_offset_pdoa_zero) << 15
        v |= int(self.turn_up) << 16
        v |= int(self.turn_down) << 17
        v |= int(self.turn_left) << 18
        v |= int(self.turn_right) << 19
        v |= (self.mode & 0x7) << 20
        v |= int(self.recal) << 23
        v |= int(self.lock) << 24
        v |= (self.dev_type & 0x7) << 25
        v |= (self.reserve & 0xF) << 28
        return v & 0xFFFFFFFF

    @property
    def battery_v(self) -> float:
        return self.battery_val / 100.0

    @property
    def dev_type_name(self) -> str:
        return DEV_TYPE_NAMES.get(self.dev_type, f"type{self.dev_type}")

    def flags(self) -> List[str]:
        out = []
        if self.is_lowbattery:
            out.append("LOWBAT")
        if self.is_alarm:
            out.append("ALARM")
        if self.is_chrg:
            out.append("CHRG")
        if self.is_tdby:
            out.append("FULL")
        if self.lock:
            out.append("LOCK")
        if self.recal:
            out.append("RECALL")
        for name, on in (("UP", self.turn_up), ("DOWN", self.turn_down),
                         ("LEFT", self.turn_left), ("RIGHT", self.turn_right)):
            if on:
                out.append(name)
        return out


@dataclass
class _FrameBase:
    saddr: int = 0
    daddr: int = 0
    cmd_type: int = 0
    cmd_direct: int = 0
    raw: bytes = b""

    @property
    def type_name(self) -> str:
        return CmdType.name(self.cmd_type)

    @property
    def direct_name(self) -> str:
        return CmdDirect.name(self.cmd_direct)


@dataclass
class LocFrame(_FrameBase):
    """A positioning report (``cmd_type`` 0x01 or 0x64)."""

    tag_time: int = 0           # uint32, tag communication timestamp
    anc_addr16: int = 0         # anchor short address
    tag_addr16: int = 0         # tag short address
    tag_sn: int = 0             # rolling sequence number
    tag_mask: int = 0           # communication-valid mask
    anchors: List[AnchorMeas] = field(default_factory=list)
    detail: TagDetail = field(default_factory=TagDetail)
    acc: tuple = (0, 0, 0)      # accelerometer x/y/z (uint16 raw)
    gyro: tuple = (0, 0, 0)     # gyroscope x/y/z (uint16 raw)
    self_raw_angle: int = 0     # int16, unfiltered angle measured by this anchor
    self_raw_range: int = 0     # uint16 cm, unfiltered range
    self_raw_degree: int = 0    # int32, raw tag angle (anchor calibration)
    angle_360: int = 0          # uint16, 360-degree angle (robot builds)
    angle_dir: int = 0          # uint8, coarse direction sector
    reserve: bytes = b""

    @property
    def has_rssi(self) -> bool:
        return self.cmd_type == CmdType.LOC_RSSI

    def anchor(self, i: int) -> Optional[AnchorMeas]:
        return self.anchors[i] if 0 <= i < len(self.anchors) else None

    def active_anchors(self) -> List[AnchorMeas]:
        """Anchors that actually produced a measurement."""
        return [a for a in self.anchors if a.valid]

    def primary(self) -> Optional[AnchorMeas]:
        """Best single measurement to plot: the first anchor that ranged."""
        act = self.active_anchors()
        return act[0] if act else None

    def xy(self) -> Optional[tuple]:
        p = self.primary()
        return p.xy() if p else None

    def summary(self) -> str:
        parts = [
            f"t={self.tag_time:>10d}",
            f"anc=0x{self.anc_addr16:04X}",
            f"tag=0x{self.tag_addr16:04X}",
            f"sn={self.tag_sn:3d}",
            f"mask=0x{self.tag_mask:02X}",
        ]
        parts += [str(a) for a in self.anchors if a.valid]
        parts.append(f"raw={self.self_raw_angle:+4d}deg/{self.self_raw_range}cm")
        parts.append(f"bat={self.detail.battery_v:.2f}V")
        parts.append(self.detail.dev_type_name)
        fl = self.detail.flags()
        if fl:
            parts.append("[" + ",".join(fl) + "]")
        return " ".join(parts)


@dataclass
class ConfigFrame(_FrameBase):
    """A config frame (``cmd_type`` 2/3/5) whose payload is an ASCII command."""

    text: str = ""
    payload: bytes = b""

    def summary(self) -> str:
        return f"{self.type_name}/{self.direct_name}: {self.text!r}"


@dataclass
class RawFrame(_FrameBase):
    """Any well-formed frame we do not decode further (e.g. OTA)."""

    payload: bytes = b""

    def summary(self) -> str:
        return f"{self.type_name}/{self.direct_name}: {self.payload.hex(' ')}"


Frame = Union[LocFrame, ConfigFrame, RawFrame]


def _parse_loc(buf: bytes, with_rssi: bool) -> LocFrame:
    """Decode the body of a positioning frame.

    Plain (0x01) and RSSI (0x64) frames share a layout up to offset 31; from
    there the RSSI variant inserts an int16 after each anchor's range, which
    shifts everything below it by 8 bytes.
    """
    f = LocFrame(
        saddr=struct.unpack_from("<Q", buf, 3)[0],
        daddr=struct.unpack_from("<Q", buf, 11)[0],
        cmd_type=buf[19],
        cmd_direct=buf[20],
        tag_time=struct.unpack_from("<I", buf, 21)[0],
        anc_addr16=struct.unpack_from("<H", buf, 25)[0],
        tag_addr16=struct.unpack_from("<H", buf, 27)[0],
        tag_sn=buf[29],
        tag_mask=buf[30],
        raw=bytes(buf),
    )

    off = 31
    stride = 6 if with_rssi else 4
    for i in range(4):
        base = off + i * stride
        angle = struct.unpack_from("<h", buf, base)[0]
        rng = struct.unpack_from("<H", buf, base + 2)[0]
        rssi = struct.unpack_from("<h", buf, base + 4)[0] if with_rssi else None
        f.anchors.append(AnchorMeas(index=i, angle_deg=angle, range_cm=rng, rssi=rssi))

    p = off + 4 * stride                      # 47 plain / 55 rssi
    f.detail = TagDetail.from_u32(struct.unpack_from("<I", buf, p)[0])
    f.acc = struct.unpack_from("<HHH", buf, p + 4)
    f.gyro = struct.unpack_from("<HHH", buf, p + 10)
    f.self_raw_angle = struct.unpack_from("<h", buf, p + 16)[0]
    f.self_raw_range = struct.unpack_from("<H", buf, p + 18)[0]
    f.self_raw_degree = struct.unpack_from("<i", buf, p + 20)[0]
    f.angle_360 = struct.unpack_from("<H", buf, p + 24)[0]
    f.angle_dir = buf[p + 26]
    f.reserve = bytes(buf[p + 27:p + 32])
    return f


def parse_frame(buf: bytes, verify: bool = True) -> Frame:
    """Decode one complete frame.

    ``buf`` must be exactly one frame: head .. foot inclusive.
    Raises :class:`FrameError` if malformed.
    """
    if len(buf) < ENVELOPE_EXTRA + 18:
        raise FrameError(f"too short: {len(buf)} bytes")
    if buf[0] != HEAD:
        raise FrameError(f"bad head 0x{buf[0]:02X}")

    cmd_len = struct.unpack_from("<H", buf, 1)[0]
    total = cmd_len + ENVELOPE_EXTRA
    if len(buf) != total:
        raise FrameError(f"length mismatch: cmd_len={cmd_len} implies {total} bytes, got {len(buf)}")
    if buf[-1] != FOOT:
        raise FrameError(f"bad foot 0x{buf[-1]:02X}")

    if verify:
        want = buf[3 + cmd_len]
        got = xor_crc(buf, 3, cmd_len)
        if want != got:
            raise FrameError(f"checksum mismatch: frame says 0x{want:02X}, computed 0x{got:02X}")

    ctype = buf[19]

    if ctype in (CmdType.LOC, CmdType.LOC_RSSI):
        with_rssi = ctype == CmdType.LOC_RSSI
        need = LOC_RSSI_LEN if with_rssi else LOC_LEN
        if len(buf) < need:
            raise FrameError(f"{CmdType.name(ctype)} frame needs {need} bytes, got {len(buf)}")
        return _parse_loc(buf, with_rssi)

    payload = bytes(buf[21:3 + cmd_len])

    if ctype in (CmdType.ANCHOR_CFG, CmdType.TAG_CFG, CmdType.ROBOT_CFG):
        return ConfigFrame(
            saddr=struct.unpack_from("<Q", buf, 3)[0],
            daddr=struct.unpack_from("<Q", buf, 11)[0],
            cmd_type=ctype,
            cmd_direct=buf[20],
            text=payload.decode("utf-8", errors="replace").rstrip("\x00").strip(),
            payload=payload,
            raw=bytes(buf),
        )

    return RawFrame(
        saddr=struct.unpack_from("<Q", buf, 3)[0],
        daddr=struct.unpack_from("<Q", buf, 11)[0],
        cmd_type=ctype,
        cmd_direct=buf[20],
        payload=payload,
        raw=bytes(buf),
    )


def build_frame(cmd_type: int, payload: bytes, saddr: int = 0, daddr: int = 0,
                cmd_direct: int = CmdDirect.ENGINE_REQ) -> bytes:
    """Assemble a frame around ``payload`` (the bytes that follow ``cmd_direct``)."""
    body = struct.pack("<QQBB", saddr & 0xFFFFFFFFFFFFFFFF,
                       daddr & 0xFFFFFFFFFFFFFFFF, cmd_type & 0xFF,
                       cmd_direct & 0xFF) + bytes(payload)
    out = bytearray()
    out.append(HEAD)
    out += struct.pack("<H", len(body))
    out += body
    out.append(xor_crc(body))
    out.append(FOOT)
    return bytes(out)


def build_config_frame(cmd_type: int, command: str, saddr: int = 0, daddr: int = 0,
                       cmd_direct: int = CmdDirect.ENGINE_REQ) -> bytes:
    """Build an anchor/tag/robot config frame carrying an ASCII ``command``."""
    if cmd_type not in (CmdType.ANCHOR_CFG, CmdType.TAG_CFG, CmdType.ROBOT_CFG):
        raise ValueError(f"not a config cmd_type: {cmd_type}")
    return build_frame(cmd_type, command.encode("utf-8"), saddr, daddr, cmd_direct)
