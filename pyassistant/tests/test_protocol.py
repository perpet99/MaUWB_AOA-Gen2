"""Protocol tests, anchored on the worked example in the vendor document.

The reference frame is [备注 6：基站定位帧示例] of the Jiuling AOA protocol PDF --
a real capture with every field annotated, which makes it the ground truth for
offsets, endianness and the checksum.
"""

import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from mauwb import commands
from mauwb.protocol import (
    CmdDirect, CmdType, ConfigFrame, FrameError, LocFrame, TagDetail,
    build_config_frame, build_frame, parse_frame, xor_crc,
)
from mauwb.stream import FrameStream, iter_frames

# [备注 6] -- the document's own example, byte for byte.
DOC_EXAMPLE_HEX = (
    "2A 4C 00 DD DD DD DD DD DD DD DD EE EE EE EE EE EE EE EE 01 05 93 23 1C 00 "
    "00 00 D8 64 87 01 F9 FF 60 00 00 00 00 00 00 00 00 00 00 00 00 00 FC 17 00 "
    "02 00 00 00 00 00 00 00 00 00 00 00 00 F9 FF 60 00 00 00 00 00 45 00 03 00 "
    "00 00 00 00 3D 23"
)
DOC_EXAMPLE = bytes.fromhex(DOC_EXAMPLE_HEX.replace(" ", ""))


class TestDocumentExample(unittest.TestCase):
    """Every assertion here is a value the PDF states explicitly."""

    def test_frame_is_81_bytes(self):
        self.assertEqual(len(DOC_EXAMPLE), 81)

    def test_envelope(self):
        self.assertEqual(DOC_EXAMPLE[0], 0x2A)       # 包头
        self.assertEqual(DOC_EXAMPLE[-1], 0x23)      # 包尾
        cmd_len = struct.unpack_from("<H", DOC_EXAMPLE, 1)[0]
        self.assertEqual(cmd_len, 0x4C)              # 76
        self.assertEqual(len(DOC_EXAMPLE), cmd_len + 5)

    def test_checksum_matches_document(self):
        cmd_len = struct.unpack_from("<H", DOC_EXAMPLE, 1)[0]
        self.assertEqual(xor_crc(DOC_EXAMPLE, 3, cmd_len), 0x3D)

    def test_decoded_fields(self):
        f = parse_frame(DOC_EXAMPLE)
        self.assertIsInstance(f, LocFrame)
        self.assertEqual(f.cmd_type, CmdType.LOC)
        self.assertEqual(f.cmd_direct, CmdDirect.ENGINE_REPORT)   # 05
        self.assertEqual(f.saddr, 0xDDDDDDDDDDDDDDDD)
        self.assertEqual(f.daddr, 0xEEEEEEEEEEEEEEEE)
        self.assertEqual(f.tag_time, 0x001C2393)
        self.assertEqual(f.anc_addr16, 0x0000)
        self.assertEqual(f.tag_addr16, 0x64D8)
        self.assertEqual(f.tag_sn, 0x87)
        self.assertEqual(f.tag_mask, 0x01)
        self.assertEqual(f.angle_360, 0x0045)
        self.assertEqual(f.angle_dir, 0x03)
        self.assertEqual(f.reserve, b"\x00" * 5)

    def test_anchor_0_measurement(self):
        f = parse_frame(DOC_EXAMPLE)
        a0 = f.anchor(0)
        # 0xFFF9 little-endian as int16. The PDF's prose says "-6" but two's
        # complement of 0xFFF9 is -7; the raw bytes are the authority.
        self.assertEqual(a0.angle_deg, -7)
        self.assertEqual(a0.range_cm, 0x0060)        # 96 cm, as the PDF states
        self.assertTrue(a0.valid)
        self.assertIsNone(a0.rssi)                   # plain LOC has no RSSI

    def test_other_anchors_idle(self):
        f = parse_frame(DOC_EXAMPLE)
        for i in (1, 2, 3):
            self.assertEqual(f.anchor(i).angle_deg, 0)
            self.assertEqual(f.anchor(i).range_cm, 0)
            self.assertFalse(f.anchor(i).valid)
        self.assertEqual(len(f.active_anchors()), 1)

    def test_self_raw_matches_anchor_0(self):
        f = parse_frame(DOC_EXAMPLE)
        self.assertEqual(f.self_raw_angle, -7)
        self.assertEqual(f.self_raw_range, 96)
        self.assertEqual(f.self_raw_degree, 0)

    def test_tag_detail_bitfield(self):
        f = parse_frame(DOC_EXAMPLE)
        d = f.detail
        self.assertEqual(d.raw, 0x020017FC)
        self.assertTrue(d.is_chrg)
        self.assertTrue(d.is_tdby)
        self.assertFalse(d.is_alarm)
        self.assertFalse(d.is_lowbattery)
        self.assertEqual(d.battery_val, 383)
        self.assertAlmostEqual(d.battery_v, 3.83, places=2)
        self.assertEqual(d.dev_type, 1)
        self.assertEqual(d.dev_type_name, "wristband")

    def test_rebuild_is_byte_identical(self):
        f = parse_frame(DOC_EXAMPLE)
        rebuilt = build_frame(f.cmd_type, DOC_EXAMPLE[21:-2],
                              f.saddr, f.daddr, f.cmd_direct)
        self.assertEqual(rebuilt, DOC_EXAMPLE)


class TestTagDetail(unittest.TestCase):
    """The three worked bitfield examples in [备注 1]."""

    def test_document_bitfield_examples(self):
        # 报警:无 / 模式:无
        d = TagDetail.from_u32(0x02001A04)
        self.assertFalse(d.is_alarm)
        self.assertEqual(d.mode, 0)
        # 报警:有 / 模式:无
        d = TagDetail.from_u32(0x02001A06)
        self.assertTrue(d.is_alarm)
        self.assertEqual(d.mode, 0)
        # 报警:无 / 模式:有
        d = TagDetail.from_u32(0x02101A24)
        self.assertEqual(d.mode, 1)

    def test_roundtrip_all_fields(self):
        d = TagDetail(
            is_lowbattery=True, is_alarm=True, is_chrg=True, is_tdby=True,
            battery_val=0x3FF, is_offset_range_zero=True,
            is_offset_pdoa_zero=True, turn_up=True, turn_down=True,
            turn_left=True, turn_right=True, mode=7, recal=True, lock=True,
            dev_type=7, reserve=0xF,
        )
        self.assertEqual(d.to_u32(), 0xFFFFFFFF)
        self.assertEqual(TagDetail.from_u32(0xFFFFFFFF).to_u32(), 0xFFFFFFFF)

    def test_battery_scale(self):
        self.assertAlmostEqual(TagDetail.from_u32(350 << 4).battery_v, 3.50)


class TestRssiFrame(unittest.TestCase):
    """cmd_type 0x64 inserts an int16 RSSI after each anchor's range."""

    def _build(self):
        b = bytearray()
        b += struct.pack("<IHHBB", 1234, 0x0001, 0x64D8, 9, 1)
        for i in range(4):
            b += struct.pack("<hHh", -10 * (i + 1), 100 * (i + 1), -80 - i)
        b += struct.pack("<I", TagDetail(battery_val=400, dev_type=2).to_u32())
        b += struct.pack("<HHH", 1, 2, 3)
        b += struct.pack("<HHH", 4, 5, 6)
        b += struct.pack("<hHi", -11, 111, -2222)
        b += struct.pack("<HB", 200, 5)
        b += b"\x00" * 5
        return build_frame(CmdType.LOC_RSSI, bytes(b), cmd_direct=CmdDirect.DEV_REPORT)

    def test_length_is_89(self):
        self.assertEqual(len(self._build()), 89)

    def test_fields_survive_the_shift(self):
        f = parse_frame(self._build())
        self.assertTrue(f.has_rssi)
        for i in range(4):
            self.assertEqual(f.anchor(i).angle_deg, -10 * (i + 1))
            self.assertEqual(f.anchor(i).range_cm, 100 * (i + 1))
            self.assertEqual(f.anchor(i).rssi, -80 - i)
        self.assertEqual(f.acc, (1, 2, 3))
        self.assertEqual(f.gyro, (4, 5, 6))
        self.assertEqual(f.self_raw_angle, -11)
        self.assertEqual(f.self_raw_range, 111)
        self.assertEqual(f.self_raw_degree, -2222)
        self.assertEqual(f.angle_360, 200)
        self.assertEqual(f.angle_dir, 5)
        self.assertEqual(f.detail.dev_type_name, "remote")


class TestConfigFrames(unittest.TestCase):

    def test_roundtrip(self):
        frame = build_config_frame(CmdType.ANCHOR_CFG, "getcfg")
        f = parse_frame(frame)
        self.assertIsInstance(f, ConfigFrame)
        self.assertEqual(f.text, "getcfg")
        self.assertEqual(f.cmd_direct, CmdDirect.ENGINE_REQ)

    def test_command_strings_match_document_examples(self):
        cases = [
            (commands.Anchor().setcfg(1, 1, 0x1111, 1),
             "setcfg 1 1 1111 1 100 1 0"),
            (commands.Anchor().addtag(0x10205FA01000154F, 0x154F),
             "addtag 10205FA01000154F 154F 0001 000A 00"),
            (commands.Anchor().deltag(0x10205FA01000154F),
             "deltag 10205FA01000154F"),
            (commands.Anchor().setslot(10), "setslot 10"),
            (commands.Anchor().setfilter(True, 30), "setfilter 1 30"),
            (commands.Anchor().retpara(0x154F, 12, 334), "retpara 154F 12 334"),
            (commands.Tag().settag(90, 110, 10, True, 3.50, True, 0x1F, 10),
             "settag 90 110 10 1 3.50 1 1f 10"),
            (commands.Robot().smode(1), "em_smode 1"),
        ]
        for frame, expected in cases:
            self.assertEqual(parse_frame(frame).text, expected)

    def test_argument_validation(self):
        a = commands.Anchor()
        for bad in (lambda: a.setcfg(0, 1, 1, 1),        # discover out of range
                    lambda: a.setcfg(1, 5, 1, 1),        # bind out of range
                    lambda: a.setcfg(1, 1, 0xFFFF, 1),   # pan id out of range
                    lambda: a.setcfg(1, 1, 1, 4),        # anchor id out of range
                    lambda: a.setcfg(1, 1, 1, 1, report_format=9),
                    lambda: a.setfilter(True, 1),        # coefficient too low
                    lambda: a.setslot(0),
                    lambda: commands.Robot().smode(3)):
            with self.assertRaises(ValueError):
                bad()


class TestMalformed(unittest.TestCase):

    def test_bad_head(self):
        b = bytearray(DOC_EXAMPLE); b[0] = 0x00
        with self.assertRaises(FrameError):
            parse_frame(bytes(b))

    def test_bad_foot(self):
        b = bytearray(DOC_EXAMPLE); b[-1] = 0x00
        with self.assertRaises(FrameError):
            parse_frame(bytes(b))

    def test_bad_checksum(self):
        b = bytearray(DOC_EXAMPLE); b[-2] ^= 0xFF
        with self.assertRaises(FrameError):
            parse_frame(bytes(b))

    def test_bad_checksum_accepted_when_not_verifying(self):
        b = bytearray(DOC_EXAMPLE); b[-2] ^= 0xFF
        self.assertIsInstance(parse_frame(bytes(b), verify=False), LocFrame)

    def test_truncated(self):
        with self.assertRaises(FrameError):
            parse_frame(DOC_EXAMPLE[:-1])


class TestStream(unittest.TestCase):

    def test_clean_back_to_back(self):
        frames = list(iter_frames(DOC_EXAMPLE * 5))
        self.assertEqual(len(frames), 5)

    def test_recovers_from_garbage_and_false_heads(self):
        blob = (b"\x11\x2a\x99" + DOC_EXAMPLE          # junk with a decoy 0x2A
                + DOC_EXAMPLE[:40]                      # a truncated frame
                + b"\x2a\x2a" + DOC_EXAMPLE
                + b"\x00\x00\x00")
        s = FrameStream()
        got = []
        for i in range(0, len(blob), 7):                # dribble it in
            got += s.feed(blob[i:i + 7])
        self.assertEqual(len(got), 2)
        self.assertGreater(s.stats.resyncs, 0)
        self.assertEqual(s.stats.frames, 2)

    def test_split_across_every_boundary(self):
        blob = DOC_EXAMPLE * 2
        for cut in range(1, len(blob)):
            s = FrameStream()
            got = s.feed(blob[:cut]) + s.feed(blob[cut:])
            self.assertEqual(len(got), 2, f"lost a frame when split at {cut}")

    def test_one_byte_at_a_time(self):
        s = FrameStream()
        got = []
        for byte in DOC_EXAMPLE * 3:
            got += s.feed(bytes([byte]))
        self.assertEqual(len(got), 3)

    def test_corrupt_frame_is_counted_not_yielded(self):
        bad = bytearray(DOC_EXAMPLE); bad[-2] ^= 0xFF
        s = FrameStream()
        got = s.feed(bytes(bad) + DOC_EXAMPLE)
        self.assertEqual(len(got), 1)
        self.assertEqual(s.stats.bad_checksum, 1)

    def test_absurd_length_does_not_stall(self):
        bad = bytearray(DOC_EXAMPLE)
        struct.pack_into("<H", bad, 1, 0xFFFF)
        s = FrameStream()
        got = s.feed(bytes(bad) + DOC_EXAMPLE)
        self.assertEqual(len(got), 1)


class TestGeometry(unittest.TestCase):

    def test_boresight_is_plus_y(self):
        f = parse_frame(DOC_EXAMPLE)
        a = f.anchor(0)
        x, y = a.xy()
        self.assertAlmostEqual(y, 0.96 * 0.9925, places=2)   # cos(-7 deg)
        self.assertLess(x, 0)                                # negative angle -> left
        self.assertAlmostEqual((x ** 2 + y ** 2) ** 0.5, 0.96, places=3)

    def test_primary_picks_first_ranging_anchor(self):
        f = parse_frame(DOC_EXAMPLE)
        self.assertIs(f.primary(), f.anchor(0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
