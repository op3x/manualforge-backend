# {{product_name}} {{model}} — Operating and Maintenance Manual

> ManualOS master template v1.1. `{{…}}` = fill-in field. Each section carries its source tags: **[PLC] [CAD] [SPEC] [USER] [STD] [HAZ]**. `REQUIRED` sections must not be empty; if no data is available the generator must emit a `NEEDS INPUT:` line instead of omitting the section.

> **Generation rules (apply to every section)**  
> The manual describes the function of the equipment: what it does, how it does it, and how people operate and maintain it safely. PLC programs and CAD models are evidence to interpret, not content to transcribe.  
> **PLC:** Read every rung of every routine. Group related rungs into functional statements (permissives + seal-in + output = one statement); summarise, do not paraphrase rung by rung. Cite rungs only as small references, e.g. 'Rungs 4-11'. Every rung must land in exactly one function group or be classed as housekeeping in app.program_xref; fail the build otherwise. No instruction mnemonics, tag names, addresses or routine names in headings or prose; tags appear only in app.io_list and app.program_xref.  
> **CAD:** Infer each subsystem's function from assembly and part names, motion components (motors, servos, cylinders, vacuum, belts, guides, heaters), sensors, guards and layout along the product flow. Describe what the equipment does and how the parts work together; part lists go to the spare-parts chapter. Use human assembly names, not CAD file names.  
> **PLC + CAD:** When PLC and CAD are both supplied, write one narrative per subsystem: CAD gives the physical arrangement, PLC gives behaviour, timing and conditions.  
> **Inferences:** Any statement inferred rather than read directly must carry an 'Inferred - please confirm' marker (rendered as a small badge) until the user confirms it.  
> **Headings:** Headings are plain-language function names (e.g. 'Case erector', 'Starting and stopping the infeed'), never 'Routine: ...' or tag names.

Document no. {{doc_number}} · Revision {{revision}} · {{date}} · {{language}} ({{original_or_translation}})

Manufacturer: {{manufacturer_name}}, {{manufacturer_address}}  
Authorised representative: {{auth_rep}}

---


# 0 Front matter

## Cover and product identification
<!-- id: front.cover · REQUIRED · seen in 10/10 · [SPEC] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(a)(b); IEC/IEEE 82079-1 -->

_Product name, model/type designation exactly as on the nameplate, manual document number, revision, language (original vs translation), manufacturer legal name and full address, authorised representative if any. Leave serial number as a fill-in field._

## Revision history / summary of changes
<!-- id: front.revision · REQUIRED · seen in 8/10 · [USER] · refs: IEC/IEEE 82079-1 -->

_Table: revision, date, sections changed, reason. Auto-append a row every time the manual is regenerated from new PLC/CAD inputs (record input file names + hashes)._

## About this manual
<!-- id: front.about · REQUIRED · seen in 9/10 · [STD] [USER] · refs: IEC/IEEE 82079-1; EU 2023/1230 Annex III 1.7.4.1 -->

_Purpose and scope of the document, target audiences (operator, maintenance, installer), list of companion documents (electrical drawings, parts catalog, PLC program, vendor component manuals), where to keep the manual, how to get a digital copy (if supplied digitally it must be downloadable, printable and savable, with the access address marked on the machine)._

## Symbols, signal words and conventions
<!-- id: front.conventions · REQUIRED · seen in 10/10 · [STD] · refs: ANSI Z535.6; ISO 3864-2; ISO 7010 -->

_Fixed text: define DANGER / WARNING / CAUTION / NOTICE per ANSI Z535.6 / ISO 3864-2, show the hazard message layout (signal word, hazard type and source, consequence, avoidance steps), list pictograms used, typographic conventions for HMI buttons, PLC tags, step lists._

### Signal words
| Signal word | Meaning |
|---|---|
| **DANGER** | Hazardous situation that, if not avoided, will result in death or serious injury. |
| **WARNING** | Hazardous situation that, if not avoided, could result in death or serious injury. |
| **CAUTION** | Hazardous situation that, if not avoided, could result in minor or moderate injury. |
| **NOTICE** | Information about practices not related to personal injury, such as property damage (no safety alert symbol). |

### How hazard messages are laid out
```
⚠ WARNING
<Hazard: what it is and where it comes from>
<Consequence: what can happen if ignored>
  ▸ <Avoidance step 1>
  ▸ <Avoidance step 2>
```
### Typographic conventions
- **Button** physical or HMI button · *Screen name* · numbered lists = steps to do in order · small grey *Rungs 4–11* = reference into the control program (see the program cross-reference appendix) · *Inferred – please confirm* badge = statement derived from CAD/PLC evidence awaiting confirmation.
- PLC tag names and addresses appear only in the I/O list and program cross-reference appendices.


# 1 Safety

## General safety instructions
<!-- id: safety.general · REQUIRED · seen in 10/10 · [STD] [HAZ] · refs: ISO 12100 -->

_Short, mandatory rules that apply to every task: read the manual first, no modification without manufacturer approval, keep guards in place, report damage, follow site rules. Original wording, imperative voice._

{{hazard_messages: filter=applies_to_sections contains 'safety.general'}}

## Personnel qualification and responsibilities
<!-- id: safety.personnel · REQUIRED · seen in 9/10 · [STD] [USER] · refs: ISO 12100; NFPA 70E; OSHA 1910.147 -->

_Define roles (operator, setter/programmer, maintenance mechanical, maintenance electrical, qualified electrical worker, service technician) and what each is permitted to do. Owner/operator obligations: training, PPE provision, site risk assessment._

## Intended use
<!-- id: safety.intended_use · REQUIRED · seen in 5/10 (gap-filled) · [SPEC] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(g); ISO 12100 5.3 -->

_Describe exactly what the machine is for: materials/workpieces, size and weight limits, environment (indoor, temperature, humidity, atmosphere), operating limits from spec sheet. State that any other use is not intended._

## Reasonably foreseeable misuse
<!-- id: safety.misuse · REQUIRED · seen in 4/10 (gap-filled) · [USER] [HAZ] · refs: EU 2023/1230 Annex III 1.7.4.2(h); ISO 12100 5.3.2 -->

_Bulleted list of prohibited uses experience shows might occur: bypassing interlocks, operating with doors open, exceeding capacity, unapproved fluids, use in explosive atmosphere, riding/climbing on machine, untrained operation._

## Workstations, danger zones and safeguarded spaces
<!-- id: safety.danger_zones · REQUIRED · seen in 6/10 · [CAD] [PLC] · refs: EU 2023/1230 Annex III 1.7.4.2(f); ISO 10218-2; ISO 13857 -->

_Describe operator workstations and danger zones (robot envelope, press point, conveyor transfer points). Use CAD envelope/footprint; include a plan-view figure with zones marked._

## Safety devices and safety functions
<!-- id: safety.devices · REQUIRED · seen in 8/10 · [PLC] [CAD] · refs: ISO 13850; IEC 60204-1 / NFPA 79; ISO 13849-1; IEC 62061; ISO 14119 -->

_Table: device, location, function, how to test, test interval. Pull from PLC safety I/O (E-stops, door interlocks, light curtains, area scanners, two-hand controls, enabling devices, STO, safe speed). Include stop categories (IEC 60204-1 cat 0/1/2) and performance level/SIL if known._

| Device | Device ref. | Location | Function / stop category | Test method | Interval |
|---|---|---|---|---|---|
| {{device}} | {{device_ref}} | {{location}} | {{function}} | {{test}} | {{interval}} |

## Emergency stop
<!-- id: safety.estop · REQUIRED · seen in 8/10 · [PLC] [CAD] · refs: ISO 13850; IEC 60204-1 10.7 -->

_Where every E-stop is, what it stops (stop category), what stays powered, how to reset and restart. Reset must not by itself restart the machine._

## Safety signs and labels on the machine
<!-- id: safety.signs · REQUIRED · seen in 7/10 · [CAD] [HAZ] [USER] · refs: ISO 7010; ANSI Z535.4; ISO 3864-2 -->

_Figure of label locations plus table: label id/part number, pictogram, meaning, location. Derive candidate labels from hazard library matches; user confirms actual label part numbers._

## Personal protective equipment
<!-- id: safety.ppe · REQUIRED · seen in 9/10 · [HAZ] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(m); OSHA 1910.132 -->

_Matrix of task vs required PPE (eye, hearing, hand, foot, head, arc-rated clothing, respirator, fall protection). Generated from hazard library matches._

| Task | Eye | Hearing | Hands | Feet | Other |
|---|---|---|---|---|---|

{{hazard_messages: filter=applies_to_sections contains 'safety.ppe'}}

## Energy isolation and lockout/tagout
<!-- id: safety.energy_isolation · REQUIRED · seen in 7/10 · [PLC] [CAD] [SPEC] · refs: OSHA 1910.147; ANSI/ASSP Z244.1; IEC 60204-1 5.3 -->

_List every energy source and its isolation point (main disconnect, pneumatic dump valve, hydraulic isolation + accumulator bleed, gravity loads to block, stored spring energy, thermal, capacitor discharge time). Then the generic LOTO steps: prepare, notify, shut down, isolate, lock and tag, release stored energy, verify zero energy, perform work, restore. Machine-specific energy-control procedure table._

### Energy sources on this machine
| # | Energy | Isolation point / device | How to release stored energy | How to verify zero energy |
|---|---|---|---|---|
| {{n}} | {{energy_type}} | {{isolation_point}} | {{release_method}} | {{verify_method}} |

### Lockout/tagout procedure (general)
1. Tell affected people that the machine will be shut down and locked out.
2. Stop the machine with its normal stop control.
3. Operate every isolation device listed above.
4. Fit your personal lock and tag to each isolation device.
5. Release or block stored energy (pressure, capacitors — wait {{capacitor_discharge_time}} min, springs, raised parts, heat).
6. Verify zero energy: try the start control, check gauges, measure voltage.
7. Do the work.
8. Before removal: tools out, guards refitted, people clear; then remove locks in reverse order and tell affected people.

## Residual risks
<!-- id: safety.residual_risks · REQUIRED · seen in 2/10 explicit (gap-filled) · [HAZ] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(l); ISO 12100 6.4 -->

_List hazards that remain after design and safeguarding, each in signal-word format, grouped by life-cycle phase. Generated from hazard library matches and confirmed against the integrator's risk assessment._

Insert one hazard message per applicable hazard-library entry (see example below), grouped by phase: transport · installation · operation · setup · cleaning · maintenance · decommissioning.

{{hazard_messages: filter=applies_to_sections contains 'safety.residual_risks'}}

## Noise, vibration, radiation and hazardous substance emissions
<!-- id: safety.emissions · optional · seen in 5/10 · [SPEC] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(u)(w)(x); ISO 4871 -->

_Declared A-weighted emission sound pressure at workstation (or statement it is <=70 dB(A)), sound power if >80 dB(A), uncertainty and test conditions; vibration; non-ionising radiation (lasers, EMF for implant wearers); airborne emissions (mist, fumes) and capture/filtration needs._

## Fire and explosion prevention
<!-- id: safety.fire · optional · seen in 3/10 · [SPEC] [USER] · refs: NFPA 79; ISO 19353 -->

_Flammable fluids (oils, coolants, fuel, dust), ignition sources, fire suppression, extinguisher type. Include only if applicable._

## Cybersecurity and protection against corruption
<!-- id: safety.cyber · optional · seen in 1/10 (gap-filled) · [PLC] [USER] · refs: EU 2023/1230 Annex III 1.1.9; IEC 62443 -->

_Network connections, remote access, password/user levels, firmware update policy, and how safety functions are protected against unauthorized changes._


# 2 Machine description and theory of operation

## What the machine does
<!-- id: product.overview · REQUIRED · seen in 10/10 · [SPEC] [PLC] [CAD] · refs: EU 2023/1230 Annex III 1.7.4.2(d) -->

_Two or three short paragraphs in plain language: the job the machine does, what goes in and what comes out, throughput, and the main stages the product passes through. Write it for a new operator who has never seen the machine. Derive the stages from the CAD top-level assemblies and the PLC main sequence; when both are present, use one merged description. No tag names, routine names, instruction mnemonics or file names anywhere in this chapter._

## Machine layout and product flow
<!-- id: product.layout · REQUIRED · seen in 6/10 (strengthened) · [CAD] [PLC] -->

_Plan-view figure with each subsystem numbered in product-flow order, plus operator positions and guard boundary. From CAD: arrange top-level assemblies by their position along the flow axis; from PLC: confirm flow order from which station hands off to which (handshake bits, sequence steps). Caption states the direction of flow._

## Main assemblies and their functions
<!-- id: product.components · REQUIRED · seen in 10/10 · [CAD] [PLC] -->

_Table: item no., assembly name (human name, not the CAD file name), one-line function. This is a summary index to the per-subsystem function sections that follow; part numbers belong in the spare-parts chapter._

## Subsystem function: {{subsystem_name}}
<!-- id: product.subsystem_function · REQUIRED · seen in 9/10 (ManualOS structure) · [CAD] [PLC] [SPEC] -->

_REPEAT once per subsystem, in product-flow order. Each instance answers, in prose plus a short fact table: (1) Purpose: what this subsystem does for the product and why; (2) Main components: the functional parts (drives, cylinders, vacuum, heaters, guides), named by function; (3) How it moves: each motion, its actuator, direction/stroke/speed if known; (4) Sensors and what each one tells the control; (5) Interlocks and permissives: what must be true before it moves and what stops it; (6) Operator interaction: what the operator loads, adjusts, watches or clears here; (7) Hazards specific to this subsystem. PLC input: read every rung of the routine(s) that control this subsystem and describe the resulting behaviour; group related rungs into one functional statement and cite them only as a small reference (e.g. 'Rungs 4-11'). CAD input: infer function from assembly and part names, purchased motion components (motors, gearboxes, servos, cylinders, vacuum cups, linear guides, belts, heaters), sensors, guards and their placement along the flow; describe what the assembly does and how the parts work together, not a parts list. Both present: merge into one narrative; CAD supplies the physical arrangement, PLC supplies behaviour and conditions. Mark any statement that is inferred rather than read directly with an 'Inferred - please confirm' marker so the user can verify._

_Repeat this block for each subsystem, in product-flow order._

### {{n}}. {{subsystem_name}}
{{purpose_paragraph: what this subsystem does for the product, in 2–4 plain sentences}}

| | |
|---|---|
| **Main components** | {{functional components, named by function}} |
| **How it moves** | {{each motion: actuator → movement, stroke/speed}} |
| **Sensors** | {{sensor → what it tells the control}} |
| **Interlocks / permissives** | {{what must be true before it moves; what stops it}} |
| **Operator interaction** | {{what the operator loads, adjusts, watches or clears}} |
| **Program reference** | *Rungs {{x–y}}* (small, grey) |

{{how_it_works_paragraph: merged CAD + PLC narrative of one cycle of this subsystem; mark inferences with the badge}}

{{hazard_messages: filter=applies_to_sections contains 'product.subsystem_function'}}

## Sequence of operation
<!-- id: product.sequence · REQUIRED · seen in 8/10 (strengthened) · [PLC] [CAD] · refs: EU 2023/1230 Annex III 1.7.4.2(d) -->

_The machine cycle from the product's point of view, as numbered steps (and an optional flow diagram): which subsystem acts, what triggers each step, what it waits for, and the hand-off to the next station. Include start-up/homing, the normal automatic cycle, cycle stop, and what happens after a fault or E-stop. Derived from the PLC main sequence / state machine, step logic and timers; if only CAD is available, infer the order from the product flow path and mark it inferred._

1. {{step: subsystem → action → trigger / wait condition → hand-off}}
2. …

_Optional flow diagram: one box per step, arrows in product-flow order, fault/E-stop branch shown separately._

## Interlocks, permissives and machine states
<!-- id: product.interlocks · REQUIRED · seen in 6/10 (gap-filled) · [PLC] · refs: IEC 60204-1 9; ISO 13849-1 -->

_Plain-language table of conditions: condition, what it prevents or allows, which subsystems are affected, how it is cleared. Covers start permissives (doors closed, air OK, safety reset, glue ready), run interlocks between stations (e.g. no pick until a case is open), and machine states (stopped, ready, running, cycle-stopping, faulted). Safety-rated functions are cross-referenced to the Safety chapter, not repeated._

| Condition | Prevents / allows | Subsystems affected | How to clear |
|---|---|---|---|
| {{condition}} | {{effect}} | {{subsystems}} | {{clear}} |

## Control logic description
<!-- id: product.control_logic · REQUIRED · seen in ManualOS addition · [PLC] -->

_Describe what the control program makes the machine do, organised by machine function (not by routine or rung order). For each function: a plain-language heading, a short paragraph of what the logic does and under which conditions, and a small rung-range reference (e.g. 'Rungs 4-11'). Read every rung; summarise related rungs (a seal-in, its permissives and its output) as one statement; never paraphrase rung by rung. Every rung must be accounted for in exactly one function group or in the program cross-reference appendix as housekeeping (comments, spare, diagnostics). No instruction mnemonics (XIC, OTE, TON...), tag names or addresses in headings or prose; use device names (e.g. 'the case-present sensor'). If no PLC program was uploaded, emit 'NEEDS INPUT: upload the PLC program to generate this section' instead._

### {{function_name}} <small>*Rungs {{x–y}}*</small>
{{what the logic makes the machine do, under which conditions, in plain language; group related rungs}}

_Repeat per function. Order by machine function (modes & start/stop → each subsystem in flow order → alarms & diagnostics), not by routine._

## Identification and nameplate
<!-- id: product.identification · REQUIRED · seen in 7/10 · [SPEC] [USER] · refs: EU 2023/1230 Annex III 1.7.3; NFPA 79 16.4 -->

_Nameplate location and fields (manufacturer, model, serial, year, voltage, FLA, SCCR, air pressure, mass, CE/UKCA/UL marks)._

Nameplate fields: manufacturer · model · serial no. · year · supply voltage/phase/Hz · full-load current · SCCR · air pressure · mass · marks (CE/UKCA/UL).

## Options and accessories
<!-- id: product.options · optional · seen in 7/10 · [SPEC] [CAD] [PLC] -->

_Installed options and how they change what the machine does; detect from PLC option bits and CAD optional assemblies, and describe the functional effect._


# 3 Transport, handling and storage

## Transport and lifting
<!-- id: transport.lifting · REQUIRED · seen in 6/10 · [CAD] [SPEC] · refs: EU 2023/1230 Annex III 1.7.4.2(p); ISO 12100 -->

_Total mass and mass of each separately shipped module, centre of gravity, lifting points, sling angles, forklift positions, transport locks to fit/remove. Weights from CAD mass properties._

{{hazard_messages: filter=applies_to_sections contains 'transport.lifting'}}

## Unpacking and inspection on receipt
<!-- id: transport.unpacking · optional · seen in 4/10 · [USER] -->

_Checklist for damage and completeness against packing list._

## Storage
<!-- id: transport.storage · REQUIRED · seen in 6/10 · [SPEC] -->

_Storage temperature/humidity range, preservation (corrosion protection, battery, desiccant), maximum storage time before re-commissioning checks._


# 4 Installation

## Site requirements and foundation
<!-- id: install.site · REQUIRED · seen in 8/10 · [CAD] [SPEC] · refs: EU 2023/1230 Annex III 1.7.4.2(i)(o) -->

_Footprint, service clearances, floor load, foundation/anchoring, leveling tolerance, ambient limits. Dimensions from CAD._

## Mechanical installation and leveling
<!-- id: install.mechanical · REQUIRED · seen in 7/10 · [CAD] -->

_Step-by-step placement, anchoring, leveling, removal of shipping locks, fitting of guards shipped loose._

{{hazard_messages: filter=applies_to_sections contains 'install.mechanical'}}

## Utility connections (electrical, air, hydraulic, water, exhaust)
<!-- id: install.utilities · REQUIRED · seen in 8/10 · [SPEC] [PLC] [CAD] · refs: NFPA 79; IEC 60204-1; ISO 8573-1 -->

_Supply voltage/frequency, full-load current, SCCR, recommended fuse/breaker, grounding/PE, cable entry; compressed air pressure/flow/quality (ISO 8573-1); hydraulic fluid; coolant; exhaust/extraction._

{{hazard_messages: filter=applies_to_sections contains 'install.utilities'}}

## Control and network connections
<!-- id: install.controls · optional · seen in 6/10 · [PLC] · refs: IEC 60204-1 -->

_External I/O interface, safety interface to host line, fieldbus/network addresses._

## Installation measures to reduce noise and vibration
<!-- id: install.noise_vibration · optional · seen in 2/10 (gap-filled) · [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(j) -->

_Mounting pads, enclosures, isolation recommendations._


# 5 Commissioning

## Pre-start checks
<!-- id: commission.prestart · REQUIRED · seen in 7/10 · [PLC] [USER] · refs: IEC 60204-1 18 -->

_Checklist: utilities, rotation direction, fluid levels, guards fitted, safety function tests (each E-stop, interlock) recorded._

{{hazard_messages: filter=applies_to_sections contains 'commission.prestart'}}

## Initial start-up and test run
<!-- id: commission.first_start · REQUIRED · seen in 7/10 · [PLC] · refs: EU 2023/1230 Annex III 1.7.4.2(k) -->

_Sequence for first power-up, homing/referencing, dry cycle, first-article run. Derived from PLC init/home sequences._

## Re-commissioning after standstill or relocation
<!-- id: commission.recommission · optional · seen in 4/10 · [USER] -->

_What to check after long storage or move._

## Operator training
<!-- id: commission.training · optional · seen in 3/10 (gap-filled) · [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(k) -->

_Training content and sign-off record._


# 6 Controls and HMI

## Control elements and indicators
<!-- id: hmi.controls · REQUIRED · seen in 8/10 · [PLC] [CAD] · refs: IEC 60204-1 10; IEC 60073 -->

_Table of every physical control (pushbutton, selector, key switch, indicator lamp, stack light colours) with location and what it makes the machine do. From PLC I/O list descriptions and the logic that uses each input. Device names only; tags belong in the I/O appendix._

| Control / indicator | Location | Type | What it does |
|---|---|---|---|

## HMI screens and navigation
<!-- id: hmi.screens · REQUIRED · seen in 8/10 · [PLC] [USER] -->

_Screen map and description of each screen; user/access levels._


# 7 Operation

## Operating modes
<!-- id: ops.modes · REQUIRED · seen in 8/10 · [PLC] · refs: EU 2023/1230 Annex III 1.2.5; ISO 10218-1 -->

_Each mode (auto, manual/jog, setup, maintenance, cleaning) with: how to select, what the machine does in that mode, which safeguards are active or muted, speed limits. From the PLC mode logic, described functionally._

| Mode | How to select | What runs | Active safeguards | Speed limit | Who may use |
|---|---|---|---|---|---|

{{hazard_messages: filter=applies_to_sections contains 'ops.modes'}}

## Daily start-up
<!-- id: ops.startup · REQUIRED · seen in 9/10 · [PLC] -->

_Power-on, warm-up, homing, safety check, start production. Step list from PLC start sequence._

{{hazard_messages: filter=applies_to_sections contains 'ops.startup'}}

## Normal operation and production
<!-- id: ops.normal · REQUIRED · seen in 9/10 · [PLC] -->

_Operator tasks during production, loading/unloading, material replenishment; refer to the Sequence of operation rather than repeating it._

{{hazard_messages: filter=applies_to_sections contains 'ops.normal'}}

## Setup, changeover and recipes
<!-- id: ops.setup · optional · seen in 6/10 · [PLC] [CAD] -->

_Changeover steps, change parts, recipe/parameter selection._

{{hazard_messages: filter=applies_to_sections contains 'ops.setup'}}

## Programming and parameters
<!-- id: ops.parameters · optional · seen in 7/10 · [PLC] -->

_User-adjustable parameters with ranges and defaults (from PLC tags flagged as HMI-writable)._

## Stopping and shutdown
<!-- id: ops.stop · REQUIRED · seen in 9/10 · [PLC] · refs: IEC 60204-1 9.2 -->

_Normal stop, cycle stop, end-of-shift shutdown, emergency stop recovery._

## Cleaning (operator level)
<!-- id: ops.cleaning · optional · seen in 5/10 · [USER] -->

_Routine cleaning, approved agents, hygiene requirements (food/pharma)._

{{hazard_messages: filter=applies_to_sections contains 'ops.cleaning'}}


# 8 Alarms, faults and troubleshooting

## Alarm and fault messages
<!-- id: trouble.alarms · REQUIRED · seen in 8/10 · [PLC] -->

_Table generated from PLC alarm list: code, text, severity/class, cause, remedy, reset method. Group by subsystem. Derive cause from the rungs that set the alarm, written as a machine condition (e.g. 'case not detected open within 1.5 s'), not as logic._

| Code | Message | Class | Probable cause | Remedy | Reset |
|---|---|---|---|---|---|
| {{alarm_code}} | {{alarm_text}} | {{severity}} | {{cause}} | {{remedy}} | {{reset}} |

## Troubleshooting guide
<!-- id: trouble.table · REQUIRED · seen in 8/10 · [PLC] [USER] -->

_Symptom -> probable cause -> remedy table for problems not tied to an alarm code._

| Symptom | Probable cause | Remedy |
|---|---|---|
| {{symptom}} | {{cause}} | {{remedy}} |

## Accidents, breakdowns, unblocking and rescue
<!-- id: trouble.emergency · REQUIRED · seen in 4/10 (gap-filled) · [PLC] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(q)(v); ISO 10218-1 -->

_How to free a trapped person (e.g. moving axes/robot without drive power, releasing brakes), clearing jams safely, fire response._

{{hazard_messages: filter=applies_to_sections contains 'trouble.emergency'}}


# 9 Maintenance

## Maintenance safety
<!-- id: maint.safety · REQUIRED · seen in 9/10 · [STD] [HAZ] · refs: EU 2023/1230 Annex III 1.7.4.2(s); OSHA 1910.147 -->

_Who may do which tasks; LOTO reference; working at height; hot surfaces; restore safeguards and test before return to service._

{{hazard_messages: filter=applies_to_sections contains 'maint.safety'}}

## Preventive maintenance schedule
<!-- id: maint.schedule · REQUIRED · seen in 7/10 · [SPEC] [CAD] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(r) -->

_Table: interval (daily/weekly/monthly/500 h/2000 h/yearly), component, task, who, reference procedure. Seed with vendor component intervals from CAD BOM purchased parts._

| Interval | Component | Task | Who | Procedure ref |
|---|---|---|---|---|
| Daily / shift | {{component}} | {{task}} | Operator | {{ref}} |
| Weekly | | | | |
| Monthly / 500 h | | | Maintenance | |
| 6-monthly / 2000 h | | | | |
| Yearly | | | Service | |

## Lubrication and fluids
<!-- id: maint.lubrication · REQUIRED · seen in 7/10 · [CAD] [SPEC] -->

_Lube points figure and table: point, lubricant spec, quantity, interval; fluid capacities._

| Point | Location (fig.) | Lubricant spec | Quantity | Interval |
|---|---|---|---|---|

## Inspection and safety-function testing
<!-- id: maint.inspection · REQUIRED · seen in 6/10 · [PLC] · refs: ISO 13849-2; ISO 14119 -->

_Periodic test of each safety device (from safety I/O list) with pass criteria._

## Maintenance and replacement procedures
<!-- id: maint.procedures · REQUIRED · seen in 7/10 · [CAD] -->

_Step-by-step for wear parts replacement (belts, filters, seals, guard windows), torque values._

{{hazard_messages: filter=applies_to_sections contains 'maint.procedures'}}

## Adjustment and calibration
<!-- id: maint.adjustment · optional · seen in 6/10 · [PLC] [CAD] -->

_Homing/reference, sensor adjustment, mastering/calibration._


# 10 Spare parts

## Spare and wear parts list
<!-- id: parts.list · REQUIRED · seen in 6/10 · [CAD] · refs: EU 2023/1230 Annex III 1.7.4.2(t) -->

_From CAD BOM: item, part number, description, qty, recommended spares (critical/wear), vendor. Mark safety-relevant parts (must be OEM spec)._

| Item | Part no. | Description | Qty | Spare class (C=critical, W=wear, S=safety-relevant) | Vendor |
|---|---|---|---|---|---|

## How to order parts and service
<!-- id: parts.ordering · optional · seen in 6/10 · [USER] -->

_Contact info, what to quote (model, serial)._


# 11 Decommissioning and disposal

## Decommissioning and dismantling
<!-- id: decom.decommission · REQUIRED · seen in 5/10 · [CAD] [USER] · refs: EU 2023/1230 Annex III 1.7.4.2(o) -->

_Safe shutdown, draining fluids, releasing stored energy, dismantling order, stability during dismantling._

{{hazard_messages: filter=applies_to_sections contains 'decom.decommission'}}

## Disposal and environmental
<!-- id: decom.disposal · REQUIRED · seen in 5/10 · [CAD] · refs: WEEE 2012/19/EU -->

_Material breakdown from CAD BOM materials; batteries, electronics (WEEE), oils, refrigerants._


# 12 Appendices

## Technical data
<!-- id: app.techdata · REQUIRED · seen in 9/10 · [SPEC] [CAD] -->

_Dimensions, mass, performance, electrical, pneumatic, hydraulic, environment, noise._

| Group | Parameter | Value | Unit |
|---|---|---|---|
| Dimensions | L × W × H | {{dims}} | mm |
| Mass | Total / heaviest module | {{mass}} | kg |
| Electrical | Voltage / phase / Hz / FLA / SCCR | | |
| Pneumatic | Pressure / flow / air class | | bar, l/min |
| Hydraulic | Pressure / tank volume / fluid | | |
| Environment | Operating temp / humidity / altitude | | |
| Noise | L_pA at workstation / L_WA | | dB(A) |

## Electrical, pneumatic and hydraulic diagrams
<!-- id: app.diagrams · optional · seen in 6/10 · [CAD] [PLC] · refs: IEC 81346; ISO 1219 -->

_Reference/attach schematics; include I/O list._

## PLC I/O and tag list
<!-- id: app.io_list · optional · seen in 2/10 (ManualOS addition) · [PLC] -->

_Full I/O table: address, tag, description, device. This and the program cross-reference are the only places where tag names and addresses appear._

## Control program cross-reference
<!-- id: app.program_xref · optional · seen in ManualOS addition · [PLC] -->

_Table mapping every PLC routine and rung range to the manual section that describes it (function group), plus rungs classed as housekeeping. Rung totals must equal the program's rung count; the generator fails the build if any rung is unaccounted for. Routine and tag names are allowed here._

| Routine | Rungs | Described in | Function group |
|---|---|---|---|
| {{routine_name}} | {{x–y}} | {{section}} | {{function_group}} |
| **Total** | **{{n}} of {{n}}** | | |

## Declaration of conformity and applied standards
<!-- id: app.compliance · REQUIRED · seen in 6/10 · [USER] [STD] · refs: EU 2023/1230 Annex III 1.7.4.2(c) -->

_DoC copy or link, list of applied standards._

## Warranty and service contacts
<!-- id: app.warranty · optional · seen in 4/10 · [USER] -->

_Warranty terms reference and service contacts._

## Glossary and abbreviations
<!-- id: app.glossary · REQUIRED · seen in 4/10 (gap-filled) · [STD] [PLC] · refs: IEC/IEEE 82079-1 -->

_Terms and abbreviations used; auto-collect abbreviations from tag descriptions._

## Index
<!-- id: app.index · optional · seen in 5/10 · [STD] -->

_Auto-generated._


---
## Example rendered hazard message (from hazard-library.json)

> ⚠ **WARNING**  
> Hydraulic systems and accumulators remain under pressure after the pump stops.  
> Escaping fluid jets can penetrate skin, and unexpected cylinder movement can crush.  
> ▸ Depressurise the system and drain accumulators before opening any connection.  
> ▸ Check the gauge reads zero.  
> ▸ Never search for leaks with your hand.
