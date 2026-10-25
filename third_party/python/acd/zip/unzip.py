import gzip
import os
import struct
from dataclasses import dataclass, InitVar
from io import BufferedReader
from pathlib import Path


def safe_member_path(directory: os.PathLike, filename: str) -> Path:
    """Return a path inside directory for an archive entry name.

    Local ManualOS patch. The archive supplies the name, so this rejects an
    empty name, a null, an absolute path, a ".." segment, and any path that
    resolves outside directory. The check happens before the file is opened.
    """
    raw = str(filename or "").replace("\\", "/")
    if not raw or "\x00" in raw:
        raise RuntimeError("archive entry name is empty or contains a null")
    if raw.startswith("/") or raw.startswith("//"):
        raise RuntimeError("archive entry name is absolute")
    if len(raw) >= 2 and raw[1] == ":":
        raise RuntimeError("archive entry name is absolute")
    parts = []
    for part in raw.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise RuntimeError("archive entry name escapes its folder")
        parts.append(part)
    if not parts:
        raise RuntimeError("archive entry name is empty")
    root = Path(directory).resolve()
    dest = root.joinpath(*parts)
    resolved = dest.resolve()
    if resolved != root and root not in resolved.parents:
        raise RuntimeError("archive entry path escapes the output directory")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    parent = resolved.parent
    if parent != root and root not in parent.parents:
        raise RuntimeError("archive entry path escapes the output directory")
    return resolved


@dataclass
class AcdHeader:
    f: BufferedReader

    def __post_init__(self):
        self.file_size = self.f.seek(-8, 2) + 8
        self.no_files, self._unknown_two = struct.unpack("II", self.f.read(8))
        self.record_offset = self.file_size - self.no_files * 528 - 8
        self.f.seek(0, 0)


@dataclass
class FileRecord:
    f: BufferedReader

    def __post_init__(self):
        self._read_filename()
        self.file_length, self.file_offset = struct.unpack("II", self.f.read(8))

    def _read_filename(self):
        end_found = False
        byte_array = b""
        while not end_found:
            # Keep reading until a null character is found
            b = self.f.read(2)
            if b == b"\x00\x00":
                end_found = True
            else:
                byte_array += b
        filename_length = len(byte_array)
        self.f.seek(520 - filename_length - 2, 1)
        self.filename = byte_array.decode("utf-16-le")


@dataclass
class Unzip:
    filename: InitVar[os.PathLike]

    def __post_init__(self, filename):
        self._filename = Path(filename)
        self._read()

    def write_files(self, directory: os.PathLike):
        # Local ManualOS patch: entry names from the archive are untrusted.
        # Reject absolute paths, ".." segments, and any path that resolves
        # outside directory before a file is created. See THIRD_PARTY_NOTICES.md.
        Path(directory).mkdir(parents=True, exist_ok=True)
        with open(self._filename, "rb") as f:
            for record in self.records:
                f.seek(record.file_offset)
                with open(safe_member_path(directory, record.filename), "wb") as out_file:
                    if f.read(2) == b"\x1f\x8b":
                        # Uncompress the files with gzip compression, the magic number is handy here.
                        f.seek(record.file_offset)
                        out_file.write(gzip.decompress(f.read(record.file_length)))
                    else:
                        f.seek(record.file_offset)
                        out_file.write(f.read(record.file_length))

    def _read_magic_number(self, f: BufferedReader):
        # Magic number is just the start of the first file in the archive
        # Even so it is a handy indicator
        magic_bytes = f.read(2)
        if magic_bytes != b"\x0d\x0a":
            raise RuntimeError("File isn't a Rockwell ACD file")
        f.seek(0, 0)

    def _read_file_header(self, f: BufferedReader):
        self.header: AcdHeader = AcdHeader(f)

    def _read_records(self, f: BufferedReader):
        f.seek(self.header.record_offset)
        self.records = []
        for _ in range(0, self.header.no_files):
            self.records.append(FileRecord(f))

    def _read(self):
        with open(self._filename, "rb") as f:
            # Check the file's magic number to confirm an ACD file
            self._read_magic_number(f)
            self._read_file_header(f)
            self._read_records(f)
