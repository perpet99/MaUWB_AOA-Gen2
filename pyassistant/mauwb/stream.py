"""Byte-stream framing: pull complete frames out of a noisy serial stream.

A UART stream gives no frame boundaries, and you will routinely join it
mid-frame or lose bytes. :class:`FrameStream` therefore never trusts a 0x2A
byte on its own -- it validates length, foot and checksum together, and on any
failure it slides forward by one byte and looks for the next candidate head.
That makes resynchronisation automatic and bounded.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Iterator, List, Optional

from .protocol import (
    ENVELOPE_EXTRA, FOOT, HEAD, Frame, FrameError, parse_frame, xor_crc,
)

__all__ = ["FrameStream", "StreamStats"]

#: Smallest legal cmd_len: saddr(8) + daddr(8) + cmd_type(1) + cmd_direct(1)
MIN_CMD_LEN = 18
#: Sanity ceiling so a corrupt length field cannot make us buffer forever.
MAX_CMD_LEN = 4096
#: Bytes we need before a length field can even be read.
MIN_HEADER = 3


@dataclass
class StreamStats:
    frames: int = 0           # frames handed out
    bad_checksum: int = 0     # head+length+foot lined up but checksum did not
    resyncs: int = 0          # times we discarded a byte to hunt a new head
    dropped_bytes: int = 0    # total bytes thrown away by resync

    def __str__(self) -> str:
        return (f"frames={self.frames} bad_crc={self.bad_checksum} "
                f"resyncs={self.resyncs} dropped={self.dropped_bytes}B")


class FrameStream:
    """Incremental frame extractor.

    Feed it whatever the transport returns; it yields complete, checksum-valid
    frames::

        stream = FrameStream()
        while True:
            for frame in stream.feed(port.read(256)):
                handle(frame)
    """

    def __init__(self, verify: bool = True, max_buffer: int = 1 << 16):
        self._buf = bytearray()
        self._verify = verify
        self._max_buffer = max_buffer
        self.stats = StreamStats()

    def __len__(self) -> int:
        return len(self._buf)

    def reset(self) -> None:
        self._buf.clear()

    def feed(self, data: bytes) -> List[Frame]:
        """Append ``data`` and return every complete frame now available."""
        if data:
            self._buf.extend(data)
            if len(self._buf) > self._max_buffer:
                # Runaway garbage: keep only the tail so we can still resync.
                excess = len(self._buf) - self._max_buffer
                self.stats.dropped_bytes += excess
                del self._buf[:excess]
        return list(self._drain())

    def feed_iter(self, data: bytes) -> Iterator[Frame]:
        """Generator flavour of :meth:`feed`."""
        if data:
            self._buf.extend(data)
        yield from self._drain()

    # -- internals ---------------------------------------------------------

    def _resync(self) -> bool:
        """Drop one byte and jump to the next plausible head.

        Returns True if a candidate head remains in the buffer.
        """
        self.stats.resyncs += 1
        del self._buf[0]
        self.stats.dropped_bytes += 1
        idx = self._buf.find(HEAD)
        if idx < 0:
            self.stats.dropped_bytes += len(self._buf)
            self._buf.clear()
            return False
        if idx > 0:
            self.stats.dropped_bytes += idx
            del self._buf[:idx]
        return True

    def _drain(self) -> Iterator[Frame]:
        while True:
            # 1. Align on a head byte.
            if not self._buf:
                return
            if self._buf[0] != HEAD:
                idx = self._buf.find(HEAD)
                if idx < 0:
                    self.stats.dropped_bytes += len(self._buf)
                    self._buf.clear()
                    return
                self.stats.dropped_bytes += idx
                del self._buf[:idx]

            # 2. Need the length field.
            if len(self._buf) < MIN_HEADER:
                return

            cmd_len = struct.unpack_from("<H", self._buf, 1)[0]
            if not (MIN_CMD_LEN <= cmd_len <= MAX_CMD_LEN):
                if not self._resync():
                    return
                continue

            total = cmd_len + ENVELOPE_EXTRA

            # 3. Need the whole frame. Not an error -- just wait for more bytes.
            if len(self._buf) < total:
                return

            candidate = bytes(self._buf[:total])

            # 4. Foot must land where the length field says.
            if candidate[-1] != FOOT:
                if not self._resync():
                    return
                continue

            # 5. Checksum.
            if self._verify:
                if candidate[3 + cmd_len] != xor_crc(candidate, 3, cmd_len):
                    self.stats.bad_checksum += 1
                    if not self._resync():
                        return
                    continue

            try:
                frame = parse_frame(candidate, verify=False)
            except FrameError:
                if not self._resync():
                    return
                continue

            del self._buf[:total]
            self.stats.frames += 1
            yield frame


def iter_frames(data: bytes, verify: bool = True) -> Iterator[Frame]:
    """Convenience: pull every frame out of an in-memory blob (e.g. a log file)."""
    stream = FrameStream(verify=verify)
    yield from stream.feed_iter(data)
