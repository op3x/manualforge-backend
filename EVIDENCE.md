# Dry-run evidence

Before is `main` at `67cc179159963056cbc280a37bff9cd7be6fb283`. After is this branch at `5100d380ccfb728aa1802b8e896764ce8bb6cf5a` (the manual code). Both passes call `generateManual` with a fake model that returns `{}`. Text is `pdftotext -layout`. There is no `examples/` directory. The repo fixtures are `test/fixtures/line.L5X` and `test/fixtures/pulley.stp`. GRFICS, the Fischertechnik SCL, and the Mecco marker come from the manual corpus (`plc/grfics_simplified_te_plcopen.xml`, `plc/fischertechnik_TP_Main.scl`, `plc/mecco_laser_dotpeen_Eip_test.L5K`).

The QA notes call eddy-14 through eddy-17 S1 findings. Those ids are the rows below. This repo has no separate S0/S1 index.

| File | Pages before | Pages after |
|---|---:|---:|
| line.L5X | 25 | 26 |
| pulley.stp | 23 | 23 |
| grfics XML | 33 | 34 |
| fischertechnik SCL | 45 | 50 |
| mecco L5K | 32 | 33 |

The pulley page count stays 23 because the notice takes the old last page. Before, page 23 opens with `12 Appendices`. After, page 22 is `11.4 Index` and page 23 is the legal notice.

## Legal notice

Constant in `lib/manual/disclaimer.js`:

`This manual is an AI-generated draft provided by ManualOS, operated by Op3x LLC, "as is" and without warranties of any kind, and it must be checked by a qualified person against the actual machine before anyone relies on it. Whoever uses this manual is responsible for reviewing it and for safe operation, maintenance and lockout/tagout, and to the fullest extent the law allows, Op3x LLC is not liable for any injury, damage or loss arising from its use. Use of this manual is governed by the ManualOS Terms at manualos.com/terms, including their limitation of liability.`

Cover pointer, the line under the DRAFT/AI notice: `Read the important legal notice on the last page before using this manual.`

On every after manual, cover page 1 line 6 is `DRAFT — GENERATED WITH AI. NOT VERIFIED.` and line 7 is that pointer. The full paragraph is not on page 1. `LEGAL DISCLAIMER PENDING` is 0 hits before and after (the placeholder was never on `67cc179`).

Joining the last page's body lines (footer, `Page N`, the running header, and `Rev. A` removed) equals `Important legal notice` plus the constant, with an empty tail:

| File | Last page | `pdftotext` lines |
|---|---:|---|
| line | 26 | 3 title, 5–9 paragraph, 14 footer `Page 26` |
| pulley | 23 | title and the same paragraph; footer `Page 23` |
| grfics | 34 | same |
| fischer | 50 | same |
| mecco | 33 | same |

`grep -c 'Important legal notice'` is 2 on each after file (cover pointer plus the last page) and 0 on each before file. `grep -c 'This manual is an AI-generated draft provided by ManualOS'` is 1 on each after file, on the last page only.

## Findings

Counts are `grep -c` on the `pdftotext -layout` output unless a line is named.

### eddy-14 — Mecco laser hazard

The QA input is `plc/mecco_Eip_test-Controller-Tags.CSV`. The word laser is only in a rung comment, `Set the laser job file name and set the command to load the job file`. On `67cc179` that comment collapses onto one tag named `MainRoutine`, so the manual never sees it.

`mecco-csv` before, 23 pages: `Laser radiation` 0, `laser job` 0, `laser safety eyewear` 0. Page 7 line 45 and page 8 line 6 are `Safety glasses`. Page 23 has the invented tag `ROUTINE`.

`mecco-csv` after, 27 pages: page 8 line 22 `Laser radiation. Class: Please confirm.`; lines 6–11 `Laser safety eyewear rated for the wavelength` and `The laser interlock must stop the beam before the enclosure is opened.`; line 26 `Wear laser safety eyewear rated for the wavelength.` Page 11 lines 13–14 quote the laser job comment. `Class 3B` is 0. `ROUTINE` is 0. The last page is the legal notice.

The L5K `mecco_laser_dotpeen_Eip_test.L5K` is the same hazard from the word laser in that file. `mecco` before: `Laser radiation` 0. `mecco` after, page 8 line 22 is the same `Laser radiation. Class: Please confirm.` line, with the same eyewear and interlock row. `This part does not move` is still 3 on pages 13 and 14; those lines are static parts.

### eddy-15 — Fischertechnik motion

`fischer` before: `no guarded motion` 1, page 7 line 4 `There is no guarded motion in this calculation.`; `Nothing moves` 3, page 12 lines 9 and 37 and page 13 line 8; `This part does not move` 2, page 12 line 15 and page 13 line 14.

`fischer` after: all three strings are 0. Page 12 line 26 reads `Powered motion is present.` The parser keeps all 87 I/O symbols (33 inputs, 54 outputs). A `QX_` / `QW_` / `QB_` / `QD_` symbol counts as motion even when the name has no motion word.

### eddy-16 — Compressed air and the saw

`fischer` before: `Pneumatic` appears only as a generic energy mention (2), `Compressor` 0, `Saw` 0.

`fischer` after: page 8 line 44 is the lockout row `Pneumatic` … `From your files`. `Compressor` 8, including page 13 line 7 and page 42 line 6 `Compressor` … `QX_MPO_Compressor_Q`. `Saw` 6, including page 42 line 36 `Saw` … `QX_MPO_M3_Saw_Q4`. Page 37 lines 6–11 are the cutting hazard: `Sharp tools, blades, knives and cut edges.` (`Sharp tools` is 0 before and 1 after).

### eddy-17 — I/O list and sensors

`fischer` before: `QX_` 0. Page 12 line 11 is `Sensors` / `None identified in the upload.`

`fischer` after: `QX_` 43, pages 39–43. Page 12 lines 29–31 list `Ref Switch Rotate`, `Ref Switch Vertical Axis`, `Light Barrier Storage`, `Light Barrier Red`, and `Light Barrier Outsourcing`. Page 13 repeats light barriers and `Switch Cantilever`. Case-insensitive `light barrier` is 0 before and 17 after. `None identified` that remains is on interlock cells, not on those sensor cells.

### eddy-19 — Export-as-SCL spam

`fischer` before: `Export the block again as SCL` 43, and `did not contain any members` 43, on pages 11, 12, 14, 15, 23, 24, and 25. Page 11 line 10 is one copy. The file is already SCL.

`fischer` after: both strings are 0.

### ion-12 — Language

Every before cover prints `English (original instructions)` once (`line` page 1 line 27). Every after cover prints `Language` / `English` (`line` page 1 line 38; `grfics` page 1 line 39; the other three page 1 line 38). `original instructions` is 1 before and 0 after on each of the five files.

### nelly-05 / nelly-06 — Lockout order

This is the same order as the extra-documents sequence: prepare, notify, shut down, isolate, apply locks, then dissipate, then verify, then restore.

`grfics` after, page 9: line 28 `Generic lockout sequence — template only.`; line 30 step 1 `Prepare.`; line 33 step 2 tell affected people; line 35 step 3 shut down; line 37 step 4 `Isolate each energy source`; line 39 step 5 apply the lock and tag, with the expected result `before stored energy is released`; line 41 step 6 `Depressurise the vessel and lines, and drain them, before you open a fitting.`; line 43 step 7 release stored energy; line 46 step 8 verify zero energy; line 52 step 11 remove locks. `Depressurise` is 0 before and 3 after (pages 7 and 9). Page 7 lines 6–7 call it a pressurised process vessel. `Process pressure` is 0 before and 2 after (pages 9–10).

`fischer` after, page 9 lines 14–23, is the same opening (Prepare, notify, shut down, isolate) and has no vessel depressurise step, because that file has no process-pressure row.
