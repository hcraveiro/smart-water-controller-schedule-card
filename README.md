# Smart Water Controller Cards

Custom Home Assistant dashboard cards for the [Smart Water Controller integration](https://github.com/hcraveiro/Home-Assistant-Smart-Water-Controller). **One HACS installation** provides three card types, with a consistent appearance.

| Card | Type | Function |
| --- | --- | --- |
| Overview and Weather | `custom:irrigation-summary-card` | Controller overview, irrigation status, upcoming and previous activity, weather and rainfall details |
| Irrigation Zones | `custom:irrigation-zones-card` | Expandable zones, manual duration, Start/Stop, live countdown and per-zone data |
| Irrigation Schedule | `custom:smart-water-controller-schedule-card` | Edit monthly intervals, irrigation times and station durations; Save to the integration |

The Schedule Card's original custom-element name remains unchanged for backward compatibility. Overview and Zones also retain their existing names.

## Installation

1. Install **Smart Water Controller Cards** through HACS (Dashboard/Frontend repository). If upgrading the original Smart Water Controller Schedule Card repository, use **Redownload** to select the desired release.
2. In **Settings → Dashboards → Resources**, ensure there is **one** HACS resource resembling:
   `/hacsfiles/smart-water-controller-schedule-card/smart-water-controller-schedule-card.js?hacstag=...`
3. Remove any *resource registrations* for standalone copies of `/local/irrigation-summary-card.js`, `/local/irrigation-zones-card.js`, `/local/irrigation-schedule-style.js`, or the `-dev` test bundle, if previously installed.
4. Reload the Home Assistant frontend. The card YAML can stay as-is.

Do not load both the standalone production card scripts and the HACS bundle: they register the same custom elements. You may retain backup files under `/config/www/`; remove only the redundant Resource entries.

## Card configuration

### Overview

```yaml
type: custom:irrigation-summary-card
mode: overview
```

This card defaults to RainBird-specific entities. Override the entity IDs in the card configuration for a different Smart Water Controller installation. The overview connection banner uses integration switch availability, independently of external automations or helpers.

### Explicit entity mapping (recommended)

The Overview and Weather modes support configuring all entity IDs directly. This is especially useful when the controller integration is recreated and entity names change.

```yaml
type: custom:irrigation-summary-card
mode: overview
controller: sensor.rainbird_controller_status
station: sensor.rainbird_current_irrigation_station
next: sensor.rainbird_next_schedule
last: sensor.rainbird_last_sprinkle
end: sensor.rainbird_irrigation_end_time
zone_statuses:
  - sensor.rainbird_front_lawn_status_1
  - sensor.rainbird_front_lawn_status_2
  - sensor.rainbird_side_lawn_status
connection_switches:
  - switch.rain_bird_sprinkler_1
  - switch.rain_bird_sprinkler_2
  - switch.rain_bird_sprinkler_3
```

The card displays **Connection lost** if *any* configured switch is `unknown`, `unavailable` or missing. It does **not** use `input_boolean.rainbird_connection_lost`; that external helper may remain in unrelated automations. Defaults are retained for existing YAML configurations. Update the IDs after recreating an integration entry if Home Assistant assigned new ones.

Weather entity mapping:

```yaml
type: custom:irrigation-summary-card
mode: weather
raining: binary_sensor.rainbird_is_it_raining_now
rain_forecast: binary_sensor.rainbird_will_it_rain_today
rain_today: sensor.rainbird_total_amount_of_rain_today
forecast_today: sensor.rainbird_total_forecasted_rain_today
rain_duration: sensor.rainbird_rain_time_today
last_rain: sensor.rainbird_last_rain
water: sensor.rainbird_total_water_consumption
```

### Weather and Rain

```yaml
type: custom:irrigation-summary-card
mode: weather
```

Weather details expand inside the same card. Both modes use the same registered card type.

### Irrigation Zones

```yaml
type: custom:irrigation-zones-card
duration: number.rainbird_irrigation_manual_duration
duration_step: 1
end_time: sensor.rainbird_irrigation_end_time
stop: button.rainbird_stop_sprinkle
show_global_stop: true
connection_switches:
  - switch.rain_bird_sprinkler_1
  - switch.rain_bird_sprinkler_2
  - switch.rain_bird_sprinkler_3
zones:
  - name: Front Lawn 1
    status: sensor.rainbird_front_lawn_status_1
    today: sensor.rainbird_sprinkle_total_amount_today_front_lawn
    planned: sensor.rainbird_forecasted_sprinkle_today_front_lawn
    remaining: sensor.rainbird_remaining_sprinkle_today_front_lawn
    start: button.rainbird_sprinkle_front_lawn_1
    valve: switch.rain_bird_sprinkler_1
  - name: Front Lawn 2
    status: sensor.rainbird_front_lawn_status_2
    today: sensor.rainbird_sprinkle_total_amount_today_side_lawn
    planned: sensor.rainbird_forecasted_sprinkle_today_side_lawn
    remaining: sensor.rainbird_remaining_sprinkle_today_side_lawn
    start: button.rainbird_sprinkle_front_lawn_2
    valve: switch.rain_bird_sprinkler_2
  - name: Side Lawn
    status: sensor.rainbird_side_lawn_status
    today: sensor.exterior_living_room_rainbird_sprinkle_total_amount_today_station_3
    planned: sensor.exterior_living_room_rainbird_forecasted_sprinkle_today_station_3
    remaining: sensor.exterior_living_room_rainbird_remaining_sprinkle_today_station_3
    start: button.rainbird_sprinkle_side_lawn
    valve: switch.rain_bird_sprinkler_3
```

Only one zone expands at a time; all start collapsed. Start, Stop, Stop All and duration adjustments are disabled if **any** entity in `connection_switches` is `unavailable` or `unknown`. These controls use the integration's switch states, not the external connection-loss helper. Start and Stop issue real Home Assistant service calls.

Station entity IDs in the example reflect one RainBird setup. Adapt them to your controller; do not assume the entity IDs are universal.

### Irrigation Schedule

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
header: false
```

To show a heading, use `header: true`. An optional `title: Irrigation Schedule` overrides the friendly name. The card loads the controller schedule from the sensor's attributes, supports month selection, days between cycles, multiple watering times and duration per station. **Save updates the real controller schedule.**

One row is always shown per station reported by the integration, even for a month that has never been configured; use `0` to skip a station in that month. **Copy this month** copies the selected month to the rest of the year or to all other months, asks for confirmation, and is only persisted when you click **Save**.

While there are unsaved changes the card shows an **Unsaved changes** badge, and **Reload** discards them and reads the schedule back from Home Assistant. The card warns you when the same time appears more than once in a month — duplicated times are counted twice when the integration works out the daily water target, so the month would get double the water you expect, and **Remove duplicates** cleans them up — and when the schedule changed in Home Assistant while you were editing, because saving would overwrite that change.

Custom station names need Smart Water Controller **1.2.1 or newer**, the first version that publishes `station_names` on the controller status sensor. Without it the card falls back to `Station 1`, `Station 2`, and so on.

#### Month calendar

Under the editor the card draws the selected month as a calendar and marks the days that will water, so you can see what the interval and the times add up to before saving. It is shown by default and can be turned off:

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
calendar: false
```

A day is marked only if the month has at least one time **and** at least one station above `0` minutes: a month with times but no minutes is configured and still waters nothing, and the calendar says so rather than drawing an empty grid.

**Future days are a projection, not a plan.** The integration does not water on fixed dates: `interval_days` counts from the last time the ground got wet, which is the later of the last rain and the last sprinkle, so rain restarts the count and moves every day after it. The calendar states which of the two it is drawing underneath the grid:

- **the current month**, when the anchor is readable: counted forward from the real last-wet date, with today marked blocked if the interval has not elapsed yet;
- **any other month**: the interval applied from the 1st, because there is no way to know what the weather will have done by then.

The anchor comes from the `interval_days`, `last_rain`, `last_sprinkle`, `interval_anchor` and `blocked_today` attributes of the integration's `*_next_schedule` sensor, which the card finds by itself. It needs Smart Water Controller **1.2.5 or newer**; with an older version the calendar still draws the pattern, without the anchor. Point it at a specific sensor if automatic discovery picks the wrong controller:

```yaml
next_schedule: sensor.rainbird_next_schedule
```

The calendar is a view, not a day editor: the stored plan is one entry per month, and there is nowhere to put "the 12th of June at 6:30" differently from the rest of June, so clicking a day does nothing.

## Tested migration

The `v2.0.0-beta.1` HACS prerelease was installed and the existing `Utilities / irri` view rendered all bundled cards successfully with **only the HACS resource enabled**. Schedule edits were verified in both directions between the original and bundled card, zone operation was tested, and the desktop click issue was retested after fixing excessive DOM rerenders. This is a user-tested setup, not an automated end-to-end compatibility guarantee.

## Development

Sources:
- `src/smart-water-controller-schedule-card.js`
- `src/schedule-style.js`
- `src/overview-card.js`
- `src/zones-card.js`

Build from the repository root with Node.js:

```sh
npm run build        # or: node scripts/build.js
```

This generates `smart-water-controller-schedule-card.js`, the single HACS resource. The script checks each source file and the bundle with `node --check`.

The schedule card is built from its readable source, like the other three. It used to be concatenated from `src/schedule-card.js`, a minified snapshot of an earlier build: that left the maintained source unused by any build, so a change to it never reached a user, and the only way to alter the shipped card was to edit minified output. `npm run build` also used to run webpack, which wrote the schedule card alone over the unified bundle in the repository root and silently dropped the other three cards; webpack now writes to `dist/` and is not part of the bundle build.

See [TESTING.md](TESTING.md) for isolated `-dev` testing, [UNIFIED-CARDS.md](UNIFIED-CARDS.md) for architecture, and [BETA-RELEASE-NOTES.md](BETA-RELEASE-NOTES.md) for prerelease notes.

## Updating and rollback

For upgrades, select the desired release in HACS, reload the browser (on desktop, `Ctrl + Shift + R`) and verify the three card types. To roll back, select a previously working HACS release via **Redownload** and reload. If returning to a release containing only the Schedule Card, restore the standalone Overview and Zones resources before using those cards.
