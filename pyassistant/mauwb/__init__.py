"""Open-source Python replacement for the closed-source MaUWB_Assistant PC tool.

Speaks the Jiuling (久凌电子) AOA UWB binary serial protocol used by the
Makerfabs MaUWB_AOA Gen2 anchors and tags.
"""

__version__ = "0.1.0"

from .protocol import (  # noqa: F401
    HEAD, FOOT, CmdType, CmdDirect, FrameError,
    AnchorMeas, TagDetail, LocFrame, ConfigFrame, RawFrame,
    parse_frame, build_frame, build_config_frame, xor_crc,
)
