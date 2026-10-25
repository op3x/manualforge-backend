"""Convert an .acd file to L5X and list non-ladder routine text.

The converter is acd-tools (hutcheb, Apache-2.0). Ladder rungs are written
into the L5X file. Structured text, function block, and sequential function
chart routines are reported on stdout when the library recovered their text,
because the L5X exporter only serialises ladder bodies.

The library's default build directory is a leaked /tmp/acd-build-* folder.
This script always passes an explicit directory. When MANUALOS_ACD_BUILD is
set, that directory is inside the caller's temp dir and the caller deletes
it, including after a timeout kills this process. Otherwise this script
creates the directory and deletes it in a finally block.
"""
import json
import os
import shutil
import sys
import tempfile

VENDOR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'third_party', 'python'))
if os.path.isdir(VENDOR) and VENDOR not in sys.path:
    sys.path.insert(0, VENDOR)


def main():
    from loguru import logger
    logger.remove()
    from acd.l5x.export_l5x import ExportL5x
    logger.remove()

    if len(sys.argv) != 3:
        print('usage: acd_to_l5x.py INPUT.ACD OUTPUT.L5X', file=sys.stderr)
        return 2
    source, dest = sys.argv[1], sys.argv[2]
    build = os.environ.get('MANUALOS_ACD_BUILD') or ''
    owned = not build
    if owned:
        build = tempfile.mkdtemp(prefix='manualos-acd-build-')
    else:
        os.makedirs(build, exist_ok=True)
    try:
        project = ExportL5x(source, build).project
        xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + project.to_xml()
        with open(dest, 'w', encoding='utf-8') as handle:
            handle.write(xml)
        routines = []
        controller = project.controller
        scopes = []
        for program in list(getattr(controller, 'programs', None) or []):
            scopes.append((getattr(program, 'name', '') or '', getattr(program, 'routines', None) or []))
        for instruction in list(getattr(controller, 'aois', None) or []):
            scopes.append((getattr(instruction, 'name', '') or '', getattr(instruction, 'routines', None) or []))
        for program_name, routine_list in scopes:
            for routine in routine_list:
                kind = str(getattr(routine, 'type', '') or '')
                rungs = []
                if kind.upper() != 'RLL':
                    for rung in getattr(routine, 'rungs', None) or []:
                        text = str(rung or '').strip()
                        if text:
                            rungs.append(text)
                routines.append({
                    'program': program_name,
                    'name': str(getattr(routine, 'name', '') or ''),
                    'type': kind,
                    'rungs': rungs,
                })
        json.dump({'routines': routines}, sys.stdout)
        return 0
    finally:
        if owned:
            shutil.rmtree(build, ignore_errors=True)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        raise SystemExit(1)
