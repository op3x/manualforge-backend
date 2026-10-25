# Test corpus notices

These files are used only by the automated tests. They are not shipped to
customers and are not part of any generated manual. Only files under
permissive licenses (MIT, Apache-2.0), US-government public-domain files, and
original ManualOS fixtures are committed here.

Files under GPL-3.0, CC-BY-3.0 and CERN-OHL-P-2.0 (the l5x-emulator project,
the GRFICSv2 Tennessee Eastman program, the FreeCAD-library NEMA 23 motor and
the Creator Transfer Chamber frame assembly) are intentionally **not**
committed. The tests that use them skip unless `MANUALOS_CORPUS` points at a
full local copy of the corpus.

| File | Source | License | Attribution |
| --- | --- | --- | --- |
| `plc/line.L5X` | Original ManualOS fixture | Proprietary (ManualOS) | Written for ManualOS tests |
| `cad/pulley.stp` | Original ManualOS fixture | Proprietary (ManualOS) | Written for ManualOS tests |
| `plc/acd_ACDTestsWithAOI.L5X` | https://github.com/hutcheb/acd/blob/main/resources/ACDTestsWithAOI.L5X | Apache-2.0 | Copyright the hutcheb/acd contributors. Licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Unmodified. |
| `plc/acd_CuteLogix.ACD` | https://github.com/hutcheb/acd/blob/main/resources/CuteLogix.ACD | Apache-2.0 | Copyright the hutcheb/acd contributors. Licensed under the Apache License, Version 2.0. Unmodified. |
| `plc/brewery_Cooker_1_AutoLogic_Program.L5X` | https://github.com/reh3376/acd-l5x-tool-lib/blob/main/docs/exports/Cooker_1_AutoLogic_Program.L5X | MIT | Copyright (c) 2025 PLC-GPT Team (reh3376/acd-l5x-tool-lib). Used under the MIT License; the copyright and permission notice of that repository apply to this file. Unmodified. |
| `cad/cadzinho_title_a1.dxf` | https://github.com/zecruel/CadZinho/blob/opengl/samples/title_a1.dxf | MIT | Copyright (c) 2018 Ezequiel Rabelo de Aguiar (CadZinho). Used under the MIT License. Unmodified. |
| `cad/nist_ftc_08_asme1_rc.stp` | https://github.com/usnistgov/SFA (NIST-PMI-STEP-Files.zip, AP203 geometry only) | Public domain (US Government work) | Courtesy of the National Institute of Standards and Technology. Not subject to copyright in the United States. Unmodified. |

## MIT License text (applies to the MIT-licensed files above, with each project's own copyright line)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
