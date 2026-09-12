"""Config command sets for anchors, tags and the robot chassis.

The payload of a config frame is plain ASCII. These helpers wrap each documented
command so you get argument checking and a frame ready to write, instead of
hand-typing strings.

Sources: [备注 3：基站配置命令集], [备注 4：标签配置命令集],
[备注 5：整机配置命令集] of the Jiuling AOA protocol document.

Commands marked "弃用" (deprecated) in the document are still accepted by the
firmware and still occupy their argument slot, so they are kept here with
sensible defaults rather than removed.
"""

from __future__ import annotations

from typing import Optional

from .protocol import CmdDirect, CmdType, build_config_frame

__all__ = ["Anchor", "Tag", "Robot", "REPORT_FORMATS", "ROBOT_MODES"]

#: setcfg x7 -- report format. The binary protocol this package parses is 0.
REPORT_FORMATS = {
    0: "generic (binary protocol - use this)",
    1: "JSON",
    2: "car-follow",
    3: "car-locate",
}

#: em_smode x1
ROBOT_MODES = {1: "follow", 2: "calibration"}


class _CommandSet:
    """Turns method calls into config frames of one ``cmd_type``."""

    CMD_TYPE: int = 0

    def __init__(self, saddr: int = 0, daddr: int = 0,
                 cmd_direct: int = CmdDirect.ENGINE_REQ):
        self.saddr = saddr
        self.daddr = daddr
        self.cmd_direct = cmd_direct

    def raw(self, command: str) -> bytes:
        """Build a frame for an arbitrary command string."""
        return build_config_frame(self.CMD_TYPE, command, self.saddr,
                                  self.daddr, self.cmd_direct)

    # Commands common to anchors and tags.
    def reset(self) -> bytes:
        """复位 - reboot."""
        return self.raw("reset")

    def rtoken(self) -> bytes:
        """恢复出厂模式 - factory reset."""
        return self.raw("rtoken")

    def save(self) -> bytes:
        """保存 - persist settings."""
        return self.raw("save")

    def saver(self) -> bytes:
        """保存&复位 - persist and reboot."""
        return self.raw("saver")

    def getver(self) -> bytes:
        """获取版本 - read firmware version."""
        return self.raw("getver")


class Anchor(_CommandSet):
    """基站配置命令集 - anchor commands (cmd_type 0x02)."""

    CMD_TYPE = CmdType.ANCHOR_CFG

    def setcfg(self, discover_tags: int, bind_tags: int, pan_id: int,
               anchor_id: int, refresh: int = 100, filt: int = 1,
               report_format: int = 0) -> bytes:
        """设置配置 - the main anchor configuration.

        :param discover_tags: 发现标签数量, 1-4
        :param bind_tags:     绑定标签数量, 1-4
        :param pan_id:        个人网络 ID, 0-0xFFFE
        :param anchor_id:     基站 ID, 0-3
        :param refresh:       刷新速率 (deprecated, kept as a positional slot)
        :param filt:          滤波设置 (deprecated, kept as a positional slot)
        :param report_format: 上报格式 -- see :data:`REPORT_FORMATS`.
                              Leave at 0 for the binary protocol this package decodes.

        Example from the document::

            setcfg 1 1 1111 1 100 1 0
        """
        if not 1 <= discover_tags <= 4:
            raise ValueError("discover_tags must be 1-4")
        if not 1 <= bind_tags <= 4:
            raise ValueError("bind_tags must be 1-4")
        if not 0 <= pan_id <= 0xFFFE:
            raise ValueError("pan_id must be 0-0xFFFE")
        if not 0 <= anchor_id <= 3:
            raise ValueError("anchor_id must be 0-3")
        if report_format not in REPORT_FORMATS:
            raise ValueError(f"report_format must be one of {sorted(REPORT_FORMATS)}")
        return self.raw(
            f"setcfg {discover_tags} {bind_tags} {pan_id:x} {anchor_id} "
            f"{refresh} {filt} {report_format}"
        )

    def getcfg(self) -> bytes:
        """获取配置."""
        return self.raw("getcfg")

    def setslot(self, ms: int) -> bytes:
        """设置时间槽周期 - slot period in ms; refresh rate is 1000/ms Hz.

        ``setslot 10`` gives a 10 ms slot, i.e. a 100 Hz update rate.
        """
        if ms <= 0:
            raise ValueError("slot period must be positive")
        return self.raw(f"setslot {ms}")

    def getslot(self) -> bytes:
        """获取时间槽周期."""
        return self.raw("getslot")

    def setfilter(self, enable: bool, coeff: int = 30) -> bytes:
        """设置硬件滤波参数.

        :param enable: 是否开启硬件滤波
        :param coeff:  硬件滤波系数, 2-50
        """
        if not 2 <= coeff <= 50:
            raise ValueError("filter coefficient must be 2-50")
        return self.raw(f"setfilter {int(bool(enable))} {coeff}")

    def getfilter(self) -> bytes:
        """获取硬件滤波参数."""
        return self.raw("getfilter")

    def addtag(self, long_addr: int, short_addr: int, fastest: int = 0x0001,
               slowest: int = 0x000A, mode: int = 0) -> bytes:
        """绑定标签 - bind a tag.

        :param long_addr:  标签长地址, 64-bit
        :param short_addr: 标签短地址, 16-bit
        :param fastest:    最快刷新速率 (deprecated slot)
        :param slowest:    最慢刷新速率 (deprecated slot)
        :param mode:       标签模式 (deprecated slot)

        Example from the document::

            addtag 10205FA01000154F 154F 0001 000A 00
        """
        return self.raw(
            f"addtag {long_addr:016X} {short_addr:04X} "
            f"{fastest:04X} {slowest:04X} {mode:02X}"
        )

    def deltag(self, long_addr: int) -> bytes:
        """删除标签 - unbind a tag by its 64-bit long address."""
        return self.raw(f"deltag {long_addr:016X}")

    def getklist(self) -> bytes:
        """获取已经配对的标签列表 - list bound tags."""
        return self.raw("getklist")

    def getdlist(self) -> bytes:
        """获取请求加入的标签列表 - list tags asking to join."""
        return self.raw("getdlist")

    def retpara(self, tag_short_addr: int, region: int, degree: int) -> bytes:
        """整机写入 360 度角度 - driven by the robot chassis, anchor A0 only."""
        return self.raw(f"retpara {tag_short_addr:04X} {region} {degree}")


class Tag(_CommandSet):
    """标签配置命令集 - tag commands (cmd_type 0x03)."""

    CMD_TYPE = CmdType.TAG_CFG

    def getid(self) -> bytes:
        """获取标签 ID."""
        return self.raw("getid")

    def gettype(self) -> bytes:
        """获取标签类型 - 0 learn-board, 1 wristband, 2 remote."""
        return self.raw("gettype")

    def settag(self, acc_min: int = 90, acc_max: int = 110, still_count: int = 10,
               work_while_charging: bool = False, alarm_voltage: float = 3.50,
               pa_enable: bool = False, uwb_power: int = 0x1F,
               rebind_retries: int = 10) -> bytes:
        """设置标签参数.

        :param acc_min:             加速度最低阈值 (default 90)
        :param acc_max:             加速度最高阈值 (default 110)
        :param still_count:         加速度静止检查次数 (default 10)
        :param work_while_charging: 充电时是否工作 (default off)
        :param alarm_voltage:       电压报警值 in volts (default 3.50)
        :param pa_enable:           是否开启 PA 功能 (default off)
        :param uwb_power:           uwb 功率设置 (default 0x1F)
        :param rebind_retries:      测距失败重新绑定次数 (default 10)

        Example from the document::

            settag 90 110 10 1 3.50 1 1f 10
        """
        return self.raw(
            f"settag {acc_min} {acc_max} {still_count} "
            f"{int(bool(work_while_charging))} {alarm_voltage:.2f} "
            f"{int(bool(pa_enable))} {uwb_power:x} {rebind_retries}"
        )

    def gettag(self) -> bytes:
        """获取标签参数."""
        return self.raw("gettag")


class Robot(_CommandSet):
    """整机配置命令集 - whole-machine / chassis commands (cmd_type 0x05)."""

    CMD_TYPE = CmdType.ROBOT_CFG

    def reset(self) -> bytes:
        return self.raw("em_reset")

    def rtoken(self) -> bytes:
        return self.raw("em_rtoken")

    def save(self) -> bytes:
        return self.raw("em_save")

    def saver(self) -> bytes:
        return self.raw("em_saver")

    def getver(self) -> bytes:
        return self.raw("em_getver")

    def smode(self, mode: int) -> bytes:
        """设置整机模式 - 1 follow (跟随模式), 2 calibration (标定模式)."""
        if mode not in ROBOT_MODES:
            raise ValueError(f"mode must be one of {sorted(ROBOT_MODES)}")
        return self.raw(f"em_smode {mode}")

    def gmode(self) -> bytes:
        """读取整机模式."""
        return self.raw("em_gmode")
