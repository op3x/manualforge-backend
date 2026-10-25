# Third-party notices

ManualOS does not ship GPL or AGPL code. The packages below were added so Rockwell ACD uploads can be converted to L5X on the server. They are vendored under `third_party/python` and loaded by `scripts/acd_to_l5x.py`. No other new runtime dependency was added.

| Package | Version | License | Copyright | Where |
| --- | --- | --- | --- | --- |
| acd-tools | 0.3a2 | Apache-2.0 | Ben Hutcheson and the hutcheb/acd contributors | `third_party/python/acd`, license text in `third_party/python/acd_tools-0.3a2.dist-info/LICENSE`. Source: https://github.com/hutcheb/acd |
| kaitaistruct | 0.11 | MIT | Copyright (c) 2015-2025 Kaitai Project | `third_party/python/kaitaistruct.py`, license text in `third_party/python/kaitaistruct-0.11.dist-info/licenses/LICENSE`. Required by acd-tools. |
| loguru | 0.7.3 | MIT | Copyright (c) 2017 | `third_party/python/loguru`, license text in `third_party/python/loguru-0.7.3.dist-info/LICENSE`. Required by acd-tools. Its Windows-only `colorama` extra is not installed. |

The block XML, STL, AWL, DXF, and STL-mesh parsers in `lib/parsers` are original ManualOS code. Test fixtures under `test/fixtures/formats` are original. The existing corpus notices remain in `test/fixtures/corpus/NOTICE.md`.

## Local patches

`third_party/python/acd/zip/unzip.py` function `write_files` is patched. Archive entry names are checked with `safe_member_path` before any file is opened. An absolute path, a `..` segment, a null, or a path that resolves outside the output directory is rejected. The upstream function joined the entry name onto the output directory with no check. `scripts/acd_to_l5x.py` also passes an explicit build directory into `ExportL5x` so the library does not create a leaked `/tmp/acd-build-*` directory. The caller deletes that directory, including when the converter is killed on timeout.
