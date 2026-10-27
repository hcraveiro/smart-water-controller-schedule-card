"""Expected watering days, computed by the integration's own scheduling rule.

The schedule card can draw a month calendar by projecting `interval_days`
forward from the anchor the integration publishes. That projection is only
worth showing if it agrees with what the integration would really do, so the
expected values in integration-projection.json come from Smart Water Controller
itself: for every scenario this script walks the month day by day and asks the
real `ScheduleStateManager.recent_event_blocks_today()` whether the day is
blocked, treating each watering as the next event.

Weather is held constant (no rain after the anchor), which is exactly the
assumption the card states next to the calendar. One extra example adds a rain
event, to show how far a real month can move away from the projection.

Usage, with a checkout of Smart Water Controller:

    python generate_from_integration.py <path-to-Home-Assistant-Smart-Water-Controller> \
        > integration-projection.json

The checkout used for the committed fixture was tag v1.1.3.
"""
import calendar
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

if len(sys.argv) != 2:
    raise SystemExit(__doc__)

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))

from tests import ha_stub  # noqa: E402  (installs the fake Home Assistant modules)
from custom_components.smart_water_controller.runtime.schedule_state import (  # noqa: E402
    ScheduleStateManager,
)


class Coordinator:
    controller_mac_address = "c8:b9:61:d3:fa:0d"
    last_rain = None
    last_sprinkle = None


def at(day, hour):
    return datetime(day.year, day.month, day.day, hour, tzinfo=timezone.utc)


def simulate(today, anchor, interval, rain_on=None):
    """The verdict for `today`, and the days of its month that water, from today on."""
    coordinator = Coordinator()
    coordinator.last_sprinkle = at(anchor, 12)
    manager = ScheduleStateManager(coordinator)

    last_day = calendar.monthrange(today.year, today.month)[1]
    watering = []
    blocked_today = None
    day = today

    while day.month == today.month and day.day <= last_day:
        if rain_on is not None and day == rain_on:
            coordinator.last_rain = at(day, 3)

        with patch.object(ha_stub.dt, "now", return_value=at(day, 6)):
            blocked = manager.recent_event_blocks_today(interval)

        if day == today:
            blocked_today = blocked

        if not blocked:
            watering.append(day.day)
            coordinator.last_sprinkle = at(day, 7)

        day += timedelta(days=1)

    return blocked_today, watering


scenarios = []

# 30, 28, 29 (leap year) and 31 days.
for year, month in [(2026, 6), (2026, 2), (2028, 2), (2026, 12)]:
    last_day = calendar.monthrange(year, month)[1]

    for today_day in sorted({1, 15, last_day}):
        today = date(year, month, today_day)

        for days_ago in (0, 1, 2, 3, 9, 30):
            anchor = today - timedelta(days=days_ago)

            for interval in (0, 1, 2, 3, 5):
                blocked_today, watering = simulate(today, anchor, interval)
                scenarios.append({
                    "year": year,
                    "monthIndex": month - 1,
                    "today": today.isoformat(),
                    "anchor": anchor.isoformat(),
                    "intervalDays": interval,
                    "blockedToday": blocked_today,
                    "waters": watering,
                })

# June, interval 2, last watering on the 10th, today the 19th, rain on the 22nd.
today = date(2026, 6, 19)
anchor = date(2026, 6, 10)
_, unchanged = simulate(today, anchor, 2)
_, with_rain = simulate(today, anchor, 2, rain_on=date(2026, 6, 22))

rain_example = {
    "year": 2026,
    "monthIndex": 5,
    "today": today.isoformat(),
    "anchor": anchor.isoformat(),
    "intervalDays": 2,
    "rainOn": "2026-06-22",
    "unchangedWeather": unchanged,
    "withRainOn22": with_rain,
}

# One scenario per line, so a change in the fixture shows up as a readable diff.
print("\n".join([
    "{",
    ' "generatedFrom": "Smart Water Controller ScheduleStateManager.recent_event_blocks_today, tag v1.1.3",',
    ' "scenarios": [',
    ",\n".join("  " + json.dumps(scenario) for scenario in scenarios),
    " ],",
    ' "rainExample": ' + json.dumps(rain_example),
    "}",
]))
