import struct
from dataclasses import dataclass
from sqlite3 import Cursor
from typing import Optional

from acd.database.dbextract import DatRecord


@dataclass
class NamelessRecord:
    _cur: Cursor
    dat_record: DatRecord

    def __post_init__(self):
        entry = NamelessRecord.parse(self.dat_record)
        if entry is not None:
            self._cur.execute("INSERT INTO nameless VALUES (?, ?, ?)", entry)

    @staticmethod
    def parse(dat_record: DatRecord) -> Optional[tuple]:
        if dat_record.identifier != 64250:
            return None
        buf = dat_record.record.record_buffer
        identifier = struct.unpack("I", buf[8:12])[0]
        object_identifier = struct.unpack_from("<I", buf, 0x0C)[0]
        return (object_identifier, identifier, buf)
