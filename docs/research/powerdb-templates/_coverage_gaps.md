# Coverage Gaps — ServiceCycle EquipmentTypes with NO PowerDB form

PowerDB is a NETA/electrical-acceptance test platform; some ServiceCycle enum types fall outside
its scope. No template exists for:

- **EMERGENCY_LIGHTING** — no PowerDB form. (Battery-backed unit testing would use generic
  Inspection Sheet 66500 or battery forms for the battery pack.) NFPA 101 monthly/annual checks
  are not modeled by PowerDB.
- **ARC_FLASH_PANEL** — no PowerDB form. Arc-flash labeling/study is a calculation deliverable,
  not a field test. PowerDB has Coordination Data forms (18xxx) that feed a study but no arc-flash sheet.
- **FIRE_PUMP_CONTROLLER** — no dedicated PowerDB form. Closest is generic Motor Starter (31000/31001)
  + Inspection Sheet (66500). NFPA 25/20 weekly churn tests are not modeled.

For these three, plan to use the generic **Inspection Sheet (Form 66500)** and **Document (11111/11112)**
capture, or build ServiceCycle-native test definitions rather than relying on a PowerDB PDF parser.

## Generic / cross-cutting PowerDB forms worth supporting in the parser
- 66500 Inspection Sheet, 11111/11112 Document, 55555 Trending, 81000 Calibration Data Log,
  52000/52005 Thermographic Inspection (-> any asset via Infrared), 28000/28100/28500/28510 Load Recordings
  & Panel Current/Voltage (-> any panel/feeder).
