"""Convert a Rockwell ACD file to L5X and list non-ladder routine text.

The converter is acd-tools (hutcheb, Apache-2.0). Ladder rungs are written
into the L5X file. Structured text, function block, and sequential function
chart routines are reported on stdout when the library recovered their text,
because the L5X exporter only serialises ladder bodies.
"""
import json
import os
import sys

VENDOR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'third_party', 'python'))
if os.path.isdir(VENDOR) and VENDOR not in sys.path:
    sys.path.insert(0, VENDOR)


def main():
    from loguru import logger
    logger.remove()
    from acd.api import ImportProjectFromFile
    logger.remove()

    if len(sys.argv) != 3:
        print('usage: acd_to_l5x.py INPUT.ACD OUTPUT.L5X', file=sys.stderr)
        return 2
    source, dest = sys.argv[1], sys.argv[2]
    project = ImportProjectFromFile(source).import_project()
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


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        raise SystemExit(1)
