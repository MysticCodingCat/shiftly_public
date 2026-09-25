# Shiftly: Template-Based Smart Shift Scheduling

> 中文：[README.md](README.md)

Pick an industry template, adjust the rules for your unit, and the system builds a monthly
roster that complies with Taiwan's Labor Standards Act using Google OR-Tools CP-SAT.
Every soft trade-off is listed, and per-person hours and rest days are shown for fairness.
It is designed for non-technical users such as head nurses and store managers.

![Schedule result](design/screenshots/result.png)

## Highlights

- **24 composable constraint blocks** driven by a JSON schema - labor law (one rest day in seven,
  11-hour rest between shifts, working-hour caps, flexible working hours), shift patterns,
  fairness (range minimisation), mentoring pairs, skill slots, team dispatch
- **7 industry templates**: nursing (3 shifts, calendar month or 4-week cycle), clinic,
  factory, security (12 h), restaurant, ground handling
- **Hard/soft toggle per rule**; soft violations are reported one by one with their cost
- **Infeasibility diagnosis**: relaxes one condition at a time to tell the user which rule to loosen;
  an arithmetic pre-check reports staff shortages in milliseconds instead of minutes
- **Manual edits with live checking**, then re-solve the rest while keeping the edits locked
- **Independent compliance checker** that audits any existing roster (including hand-made Excel);
  tests require every solver result to pass it with zero violations
- **Scales linearly**: 300 staff x 31 days -> first feasible roster in 5.8 s, 194 MB memory
- **Hardened API**: scrypt hashing, rate limiting, server-side forced password change,
  clamped solver settings, per-user job limits, owner checks on job results

A runnable, simplified illustration of the modelling techniques is in
[`engine-excerpt/toy_scheduler.py`](engine-excerpt/toy_scheduler.py).
Architecture notes: [design/architecture.md](design/architecture.md) (Chinese).

**Stack**: Python 3.11, OR-Tools CP-SAT, FastAPI, Pydantic v2, SQLite, openpyxl,
vanilla JavaScript, pytest (100 tests), Playwright.

## What is public

This repository is a portfolio showcase, **not the full product**, and cannot be deployed as a service.

| Part | Status |
|---|---|
| Frontend, API layer, data schema, API security tests | Public |
| Simplified modelling excerpt | Public, runnable |
| Constraint block implementations, solve pipeline, diagnosis, checker, linter, templates, engine tests | **Private** |

## Copyright

(c) 2026 陳伯榕 (MysticCodingCat). All rights reserved. Provided for viewing as a portfolio only;
no permission is granted to copy, modify, distribute, or use it commercially. See [LICENSE](LICENSE).
