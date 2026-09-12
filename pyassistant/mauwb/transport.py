"""Transports: where the byte stream comes from.

Three sources are supported, all behind the same tiny interface
(``open`` / ``read`` / ``write`` / ``close``), so every tool in this package
works identically against live hardware, a TCP bridge, or a recorded log:

* :class:`SerialTransport` -- a USB/UART anchor (the normal case)
* :class:`TcpTransport`    -- an anchor reached over a serial-to-Ethernet bridge
* :class:`FileTransport`   -- replay of a ``.bin`` capture, optionally in real time
"""

from __future__ import annotations

import socket
import time
from typing import List, Optional

__all__ = [
    "Transport", "SerialTransport", "TcpTransport", "FileTransport",
    "list_serial_ports", "open_transport",
]


class Transport:
    """Base interface. ``read`` returns b"" on timeout, never blocks forever."""

    name = "transport"

    def open(self) -> None:
        raise NotImplementedError

    def read(self, size: int = 4096) -> bytes:
        raise NotImplementedError

    def write(self, data: bytes) -> int:
        raise NotImplementedError

    def close(self) -> None:
        pass

    @property
    def eof(self) -> bool:
        """True when no more data will ever arrive (finite sources only)."""
        return False

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class SerialTransport(Transport):
    """A pyserial port.

    The anchors enumerate as a CP210x/CH340-class USB-UART. 115200 8N1 is the
    factory default; ``MaUWB_Assistant`` also offers 921600 for high slot rates.
    """

    def __init__(self, port: str, baudrate: int = 115200, timeout: float = 0.1):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self._ser = None
        self.name = f"serial:{port}@{baudrate}"

    def open(self) -> None:
        try:
            import serial  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "pyserial is required for serial transport: pip install pyserial"
            ) from e
        self._ser = serial.Serial(
            port=self.port,
            baudrate=self.baudrate,
            bytesize=8,
            parity="N",
            stopbits=1,
            timeout=self.timeout,
        )
        # Some USB-UART bridges hold the device in reset until these are set.
        try:
            self._ser.dtr = True
            self._ser.rts = False
        except (OSError, AttributeError):
            pass
        self._ser.reset_input_buffer()

    def read(self, size: int = 4096) -> bytes:
        if self._ser is None:
            raise RuntimeError("port not open")
        waiting = self._ser.in_waiting
        # read() honours the timeout; read at least 1 byte so we block briefly
        # instead of spinning the CPU when the link is idle.
        return self._ser.read(max(1, min(size, waiting or 1)))

    def write(self, data: bytes) -> int:
        if self._ser is None:
            raise RuntimeError("port not open")
        n = self._ser.write(data)
        self._ser.flush()
        return n or 0

    def close(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            finally:
                self._ser = None


class TcpTransport(Transport):
    """Anchor behind a serial-to-Ethernet bridge (transparent TCP)."""

    def __init__(self, host: str, port: int, timeout: float = 0.1):
        self.host = host
        self.port = port
        self.timeout = timeout
        self._sock: Optional[socket.socket] = None
        self._eof = False
        self.name = f"tcp:{host}:{port}"

    def open(self) -> None:
        self._sock = socket.create_connection((self.host, self.port), timeout=5.0)
        self._sock.settimeout(self.timeout)
        self._eof = False

    def read(self, size: int = 4096) -> bytes:
        if self._sock is None:
            raise RuntimeError("socket not open")
        try:
            data = self._sock.recv(size)
        except socket.timeout:
            return b""
        if not data:
            self._eof = True
        return data

    def write(self, data: bytes) -> int:
        if self._sock is None:
            raise RuntimeError("socket not open")
        self._sock.sendall(data)
        return len(data)

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None

    @property
    def eof(self) -> bool:
        return self._eof


class FileTransport(Transport):
    """Replay a raw capture written by ``mauwb_cli.py log --raw``.

    ``speed`` scales playback: 1.0 approximates the original wire rate by
    pacing on ``chunk``/baud, 0 replays as fast as the CPU allows.
    """

    def __init__(self, path: str, chunk: int = 256, speed: float = 1.0,
                 baudrate: int = 115200, loop: bool = False):
        self.path = path
        self.chunk = chunk
        self.speed = speed
        self.baudrate = baudrate
        self.loop = loop
        self._fh = None
        self._eof = False
        self.name = f"file:{path}"

    def open(self) -> None:
        self._fh = open(self.path, "rb")
        self._eof = False

    def read(self, size: int = 4096) -> bytes:
        if self._fh is None:
            raise RuntimeError("file not open")
        n = min(size, self.chunk)
        data = self._fh.read(n)
        if not data:
            if self.loop:
                self._fh.seek(0)
                data = self._fh.read(n)
            if not data:
                self._eof = True
                return b""
        if self.speed > 0:
            # 10 bits per byte on the wire (8N1 + start + stop).
            time.sleep(len(data) * 10.0 / self.baudrate / self.speed)
        return data

    def write(self, data: bytes) -> int:
        return 0  # replay is read-only; swallow writes so tools stay uniform

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            finally:
                self._fh = None

    @property
    def eof(self) -> bool:
        return self._eof


def list_serial_ports() -> List[tuple]:
    """Return ``(device, description, hwid)`` for every serial port present."""
    try:
        from serial.tools import list_ports  # type: ignore
    except ImportError:
        return []
    return [(p.device, p.description, p.hwid) for p in list_ports.comports()]


def open_transport(spec: str, baudrate: int = 115200, timeout: float = 0.1,
                   speed: float = 1.0, loop: bool = False) -> Transport:
    """Build a transport from a URL-ish string.

    ===========================  ==========================================
    ``COM7`` / ``/dev/ttyUSB0``  serial port
    ``tcp://192.168.1.50:8888``  serial-to-Ethernet bridge
    ``file://capture.bin``       replay a raw capture
    ===========================  ==========================================
    """
    if spec.startswith("tcp://"):
        rest = spec[len("tcp://"):]
        host, _, port = rest.rpartition(":")
        if not host:
            raise ValueError("tcp:// spec needs host:port")
        return TcpTransport(host, int(port), timeout=timeout)
    if spec.startswith("file://"):
        return FileTransport(spec[len("file://"):], speed=speed,
                             baudrate=baudrate, loop=loop)
    return SerialTransport(spec, baudrate=baudrate, timeout=timeout)
