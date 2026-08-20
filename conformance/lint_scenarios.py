#!/usr/bin/env python3
"""Check the conformance scenarios are well-formed before any runner reads them.

Four SDKs will execute this YAML. A typo in a behaviour id or a duplicated
scenario id would show up as a mysteriously-skipped test in one language and not
another, which is exactly the drift the suite exists to prevent — so it is worth
a cheap structural check in CI.

Also enforces the rule from spec/ERGONOMICS.md: every behaviour that claims to be
implemented must be covered by at least one scenario.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
SCENARIO_DIR = ROOT / "scenarios"

KNOWN_BEHAVIOURS = {"E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"}
# E7 (typed catalog) and E8 (editor environments) are specified but not yet
# implemented, so they are not expected to have scenarios. Remove an id from
# here the moment its behaviour ships.
NOT_YET_IMPLEMENTED = {"E7", "E8"}

REQUIRED_KEYS = {"id", "behaviour", "title", "steps"}


def main() -> int:
    problems: list[str] = []
    seen_ids: dict[str, Path] = {}
    covered: set[str] = set()
    total = 0

    files = sorted(SCENARIO_DIR.glob("*.yaml"))
    if not files:
        print(f"no scenario files found under {SCENARIO_DIR}")
        return 1

    for path in files:
        try:
            doc = yaml.safe_load(path.read_text())
        except yaml.YAMLError as exc:
            problems.append(f"{path.name}: not valid YAML — {exc}")
            continue

        if not isinstance(doc, dict) or "scenarios" not in doc:
            problems.append(f"{path.name}: missing a top-level `scenarios` list")
            continue

        for index, scenario in enumerate(doc["scenarios"]):
            total += 1
            where = f"{path.name}[{index}]"

            if not isinstance(scenario, dict):
                problems.append(f"{where}: scenario is not a mapping")
                continue

            missing = REQUIRED_KEYS - scenario.keys()
            if missing:
                problems.append(f"{where}: missing {sorted(missing)}")
                continue

            scenario_id = scenario["id"]
            if scenario_id in seen_ids:
                problems.append(
                    f"{where}: duplicate id '{scenario_id}' "
                    f"(also in {seen_ids[scenario_id].name})"
                )
            seen_ids[scenario_id] = path

            behaviour = scenario["behaviour"]
            if behaviour not in KNOWN_BEHAVIOURS:
                problems.append(
                    f"{where}: unknown behaviour '{behaviour}' "
                    f"(expected one of {sorted(KNOWN_BEHAVIOURS)})"
                )
            else:
                covered.add(behaviour)

            steps = scenario["steps"]
            if not isinstance(steps, list) or not steps:
                problems.append(f"{where}: `steps` must be a non-empty list")

    expected = KNOWN_BEHAVIOURS - NOT_YET_IMPLEMENTED
    uncovered = sorted(expected - covered)
    if uncovered:
        problems.append(
            f"behaviours with no scenario: {uncovered}. "
            "An implemented behaviour with no scenario will drift between SDKs."
        )

    if problems:
        print(f"{len(problems)} problem(s) in the conformance scenarios:\n")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print(
        f"{total} scenarios across {len(files)} file(s); "
        f"behaviours covered: {', '.join(sorted(covered))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
