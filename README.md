# Smart Water Controller Cards

Custom Home Assistant dashboard cards for the [Smart Water Controller integration](https://github.com/hcraveiro/Home-Assistant-Smart-Water-Controller). **One HACS installation** provides three card types, with a consistent appearance.

| Card | Type | Function |
| --- | --- | --- |
| Overview and Weather | `custom:irrigation-summary-card` | Controller overview, irrigation status, upcoming and previous activity, weather and rainfall details |
| Irrigation Zones | `custom:irrigation-zones-card` | Expandable zones, manual duration, Start/Stop, live countdown and per-zone data |
| Irrigation Schedule | `custom:smart-water-controller-schedule-card` | Edit monthly intervals, irrigation times and station durations; Save to the integration |

The Schedule Card's original custom-element name remains unchanged for backward compatibility. Overview and Zones also retain their existing names.

### Consistent green sprinkler icons (V2.0.8b2)

- Use the same theme-aware green `--success-color` for the sprinkler
  icons in selected-day projected station cards, empty projected days and
  the calendar legend. Blue remains reserved for the rainfall icon.
- No changes to irrigation amounts, scheduling or weather calculations.

### Calendar empty-day sprinkler icon (V2.0.8b1)

- Show the existing sprinkler icon before **No irrigation currently projected**
  in the selected-day Schedule Card details, matching the visual treatment of
  the rain summary. Calculations and calendar projection logic are unchanged.

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

### Multi-controller Overview (optional)

Use `controllers` only with `mode: overview`. The card displays a global
earliest upcoming irrigation, latest completed irrigation, combined controller
states, and a collapsible section for each controller (expanded by default). Unknown or unavailable
states are never counted as Off. A controller can irrigate simultaneously
with another controller; each active section shows its own countdown.
The Weather mode remains unchanged.

```yaml
type: custom:irrigation-summary-card
mode: overview
controllers:
  - name: Rain Bird
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
  - name: Solem Bushes
    controller: sensor.solem_bushes_controller_status
    station: sensor.solem_bushes_current_irrigation_station
    next: sensor.solem_bushes_next_schedule
    last: sensor.solem_bushes_last_sprinkle
    end: sensor.solem_bushes_irrigation_end_time
    zone_statuses:
      - sensor.solem_bushes_bushes_status
    connection_switches: []
```

Existing single-controller YAML is unchanged.

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

To show **separate cumulative water consumption values** for multiple controllers,
use the optional `water_sensors` array in Weather mode. Each item needs a
display `name` and an `entity`. When omitted, the existing single `water`
sensor remains in use.

```yaml
type: custom:irrigation-summary-card
mode: weather
raining: binary_sensor.rainbird_is_it_raining_now
rain_forecast: binary_sensor.rainbird_will_it_rain_today
rain_today: sensor.rainbird_total_amount_of_rain_today
forecast_today: sensor.rainbird_total_forecasted_rain_today
rain_duration: sensor.rainbird_rain_time_today
last_rain: sensor.rainbird_last_rain
water_sensors:
  - name: Rain Bird
    entity: sensor.rainbird_total_water_consumption
  - name: Solem Bushes
    entity: sensor.solem_bushes_total_water_consumption
```

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

### Controller Run Cycle and Stop All (V2.0.6)

In the Irrigation Overview, each controller retains its four existing tiles:
**Next irrigation**, **Last irrigation**, **Current station**, and **Controller**.
A small action row underneath switches automatically between:

- **Run Cycle / Start** while the controller is idle and on. The description
  shows the number of stations and the sum of their configured durations in
  the current month's schedule, read directly from the controller sensor.
- **Stop All** when that controller is executing a scheduled cycle
  (`automatic`) or manual Run Cycle (`manual_cycle`). This cancels the full
  cycle for that controller only.
- A non-interactive status when a single manual (`manual`) or external irrigation
  is in progress. Use **Stop** in Irrigation Zones for the individual station.

Both actions ask for confirmation and use the real Home Assistant `button.press`
service. Buttons are disabled while busy, when the controller is unavailable,
or when there is no valid command / monthly schedule. Commands are resolved by
a unique match to the controller's existing HA entities, including generated
entity IDs. Ambiguous matches are refused.

Explicit mappings are supported if customised entity names cannot be resolved:

```yaml
type: custom:irrigation-summary-card
mode: overview
controllers:
  - name: Lawn
    controller: sensor.rainbird_controller_status
    run_cycle: button.exterior_living_room_rainbird_run_cycle
    stop: button.rainbird_stop_sprinkle
    # Keep the controller's existing next, last, station, end and zone_statuses.
```

The existing dashboard YAML does not need changing when the entities can be
resolved automatically. Independent controllers have independent controls.

### Irrigation source indicators (V2.0.6)

When a station is running, Overview and Irrigation Zones read the integration's existing
`irrigation_source` state attribute. No new entity or dashboard YAML changes are needed.

- `manual_cycle`: **Manual cycle running** in Overview and **Manual cycle** in the active zone.
- `automatic`: **Scheduled watering**.
- `manual`: **Manual watering**.
- `external`: **External watering**.

For a manual cycle, **Station ends in** replaces **Stopping in**, because the timer
shows the current station's end time, not the full cycle completion time.
Other countdowns retain the existing wording. If the source attribute is missing
or unrecognised, generic running labels are preserved for backwards compatibility.

### Stop and Stop All (V2.0.6)

The active station always uses the same **Stop** label in expanded controls
when its dedicated station-stop entity is available. Stop ends **only that station**.
During scheduled or manual cycles the controller advances safely to the next station.

**Stop All** is shown directly on the active zone **only for scheduled cycles
(`automatic`) and Run Cycle (`manual_cycle`)**, even when the zone is collapsed.
It cancels the entire sequence of that controller. A standalone manual watering
(`manual`) never displays Stop All.

The card resolves dedicated station-stop entities through an explicit
`stop_station:` mapping or, when possible, by finding a unique entity with the
same controller and station name. For example, a legacy start entity
`button.rainbird_sprinkle_front_lawn_1` is matched with the actual
`button.exterior_living_room_rainbird_stop_front_lawn_1`.
Ambiguous matches are rejected rather than controlling the wrong valve.

An optional explicit mapping avoids any dependency on generated entity IDs:
```yaml
zones:
  - name: Front Lawn 1
    status: sensor.rainbird_front_lawn_status_1
    start: button.rainbird_sprinkle_front_lawn_1
    stop_station: button.exterior_living_room_rainbird_stop_front_lawn_1
```

For multiple controllers, use the controller-specific `stop:` field on
non-primary controller zones. The card hides Stop All rather than risk
stopping another controller.

The legacy footer-based Stop All is still available with
`show_zone_stop_all: false`, but only during cycles.
The integration must expose the station-specific Stop button
(Smart Water Controller V1.1.6 or later).

### Multiple controllers in one Zones Card

Zones from different integration entries may be displayed together. Assign a
`controller` identifier to each zone and override `duration`, `end_time`,
`stop`, and `connection_switches` when they differ from the card defaults.
Independent controllers may irrigate simultaneously; one controller's active zone
does not disable another controller's Start button.

```yaml
type: custom:irrigation-zones-card
show_global_stop: false
zones:
  - name: Front Lawn 1
    controller: rainbird
    status: sensor.rainbird_front_lawn_status_1
    today: sensor.rainbird_sprinkle_total_amount_today_front_lawn
    planned: sensor.rainbird_forecasted_sprinkle_today_front_lawn
    remaining: sensor.rainbird_remaining_sprinkle_today_front_lawn
    start: button.rainbird_sprinkle_front_lawn_1
  # Include other Rain Bird zones as usual, with controller: rainbird.
  - name: Bushes
    controller: solem_bushes
    status: sensor.solem_bushes_bushes_status
    today: sensor.solem_bushes_sprinkle_total_amount_today_bushes
    planned: sensor.solem_bushes_forecasted_sprinkle_today_bushes
    remaining: sensor.solem_bushes_remaining_sprinkle_today_bushes
    start: button.solem_bushes_sprinkle_bushes
    stop: button.solem_bushes_stop_sprinkle
    duration: number.solem_bushes_irrigation_manual_duration
    end_time: sensor.solem_bushes_irrigation_end_time
    connection_switches: []
```

Stop All is shown within the running zone during a scheduled or manual cycle,
including multi-controller layouts when a controller-specific stop command is available.
A manual single-station watering displays only its per-station Stop button.
Controller-specific `stop:` mappings are recommended for controllers with
custom or ambiguous entity IDs.

Only one zone expands at a time; all start collapsed. Start, Stop, Stop All and duration adjustments are disabled if **any** entity in `connection_switches` is `unavailable` or `unknown`. These controls use the integration's switch states, not the external connection-loss helper. Start and Stop issue real Home Assistant service calls.

Station entity IDs in the example reflect one RainBird setup. Adapt them to your controller; do not assume the entity IDs are universal.


### Equal compact rain summary heights (V2.0.7b8)

- Give both historical `Rainfall` and projected `Rain forecast` panels a
  shared 64px minimum height and 6px vertical padding.
- Allow either panel to grow if accessibility settings or narrower screens
  cause additional text wrapping. The Schedule Card station cards remain 82px.
- Keep all irrigation values, progress bars, and calendar calculations unchanged.

### More compact day details (V2.0.7b7)

- Reduce historical and projected station mini-cards equally from 96px to 82px.
- Reduce station padding while preserving the solid and striped progress bars.
- Remove the fixed 84px rainfall card minimum height; both past rainfall
  and projected rain forecast now fit naturally around their text.
- Reduce rainfall card vertical padding. On a very narrow screen, the
  station cards may still grow to prevent text clipping.
- Keep history, projected amounts, calendar layout and calculations unchanged.

### Consistent rainfall summary heights (V2.0.7b6)

- Fix the selected-day **Schedule Card** panel appearing taller for future
  dates on Android tablets because the longer `Rain forecast` explanation
  wraps into multiple lines.
- Both historical `Rainfall` and future `Rain forecast` summaries now
  use the same 84px minimum height, and expand if the text requires more.
- Station cards, irrigation amounts, calculations and forecasts are unchanged.

### Consistent tablet station mini-card heights (V2.0.7b5)

- Use an identical 96px outer height for historical and projected
  station mini-cards in the calendar selected-day panel on tablets.
- Distribute the content consistently inside each card instead of relying
  on browser-specific intrinsic height and line spacing.
- Allow flexible card height on very narrow displays to avoid text clipping.
- Keep existing planned/historical bars, values, and controls unchanged.

### Consistent selected-day station card heights (V2.0.7b4)

- Match projected irrigation progress-track height to historical actual progress
  (9 px each), preserving the dashed and striped projected design.
- Align the same station mini-card spacing and layout for historical and
  projected days on narrow/tablet views.
- No changes to calculations, rainfall cards, sensors, or dashboard settings.

### Capped irrigation progress (V2.0.7b3)

- Calendar historical **Actual / Planned** amounts remain unchanged, even
  when actual irrigation exceeds the target because of weather decisions
  or manual watering. Both the progress bar and the **% applied** text
  are limited to **100%** (e.g. `2.14 / 0.04 mm` displays `100% applied`,
  not `5350% applied`).
- If a station watered while its planned target was exactly `0 mm`,
  the calendar shows **Watered without planned target** instead of a
  mathematically undefined percentage. With zero watering and a zero
  target it shows **No irrigation planned**.
- Irrigation Zones already capped progress to 100%; verified with new
  tests. When irrigation occurred against a `0 mm` target, the Zones
  expanded panel now shows **Watered without planned target** without
  manufacturing a progress bar or percentage.
- No integration changes, new sensors or history storage required.
  Projected irrigation visuals and values are unchanged.

### Selected-day mini-cards (V2.0.7b2)

The selected calendar day now uses a compact, theme-aware card layout:

- **Header:** selected date and an **Actual / Planned** or **Projected
  irrigation** status pill.
- **Historical station mini-cards:** station name, actual / planned mm,
  a **solid progress bar** showing how much of the recorded target was
  applied, and a compact applied-percentage label. The bar caps at 100%
  if the applied amount exceeds the target; the label still shows the
  full percentage.
- **Future station mini-cards:** projected mm, a **striped and dashed
  bar** to distinguish prediction from actual progress, and
  **Planned · Pending**. The projected bar does not imply 100%
  completion. Missing rates use an empty dashed bar and a
  **Projection unavailable** label.
- **Rain card:** actual recorded rainfall in mm for historic days, or
  rainfall forecast probability/threshold information for future days.
- **Safety and accessibility:** zero/missing targets never fabricate
  percentages, active progress bars expose accessible progress values,
  and station names are escaped. Existing day selection and calendar
  projection calculations are unchanged.

The redesign uses Home Assistant theme CSS variables, supports dark and
light themes, and keeps compact spacing for two schedule cards side by
side. No integration or dashboard configuration changes are required.



With `calendar: true` and `calendar_history: true`, selecting a past or
current day shows **Actual / Planned (mm)** for every station, followed by
**Rainfall** (always in mm). For example, `1.00 / 4.00 mm` and
`Rainfall: 3.00 mm` distinguish irrigation actually applied from the
configured target, even after rain reduces the watering requirement.

- **Actual** reads the existing per-station `Sprinkle Total Amount Today`
  history (`state` in Home Assistant Long-Term Statistics).
- **Planned** reads each `Forecasted Sprinkle Today` sensor's recorded
  hourly `mean` statistic, since those sensors use
  `state_class: measurement`. The most recent hourly measurement from
  that local day is used. Today's values come directly from live states.
- No additional persistence, integration sensor or Recorder retention is
  required for the mm view. Missing recorded planned values are shown
  as `No data`, not retroactively guessed from today's schedule.
- If the actual entity is named
  `sensor.rainbird_sprinkle_total_amount_today_front_lawn`, the card
  automatically matches
  `sensor.rainbird_forecasted_sprinkle_today_front_lawn`. This
  also supports the `..._station_3` naming convention.
- For any other entity naming, provide an optional parallel list,
  in the same order as `calendar_station_sensors`:

```yaml
calendar_planned_station_sensors:
  - sensor.rainbird_forecasted_sprinkle_today_front_lawn
  - sensor.rainbird_forecasted_sprinkle_today_side_lawn
  - sensor.exterior_living_room_rainbird_forecasted_sprinkle_today_station_3
```

For a selected **future watering day**, the details now show
**Projected watering (mm)**, never minutes. The card derives each
station's nominal mm/min rate from today's planned-mm sensor and the
current month's scheduled minutes, then multiplies by the selected
month's scheduled duration. Future values are projections, not promises:
rain, schedule changes and controller decisions may change them.

If today's watering target is zero because watering was blocked,
the card can use a previous positive planned-mm measurement from the
current month. If no reliable rate is available, it shows
`No plan data` rather than fabricating mm. For controllers that
cannot derive a rate automatically, configure a per-station rate:

```yaml
calendar_station_mm_per_minute: [0.42, 0.42, 0.42]
```

Rainfall remains in **mm** in both historical and projected details.
This beta implements **mm only**; a later release may add the
requested minutes-and-seconds display once historical duration
statistics are available.

### Experimental calendar rain and irrigation markers

The optional enhanced calendar combines **recorded** daily rain/irrigation for past days with
**projected** irrigation and daily rain forecasts for future days. These options are off by
default and available in the current release:

```yaml
calendar: true
calendar_history: true
calendar_rain_sensor: sensor.rainbird_total_amount_of_rain_today
calendar_station_sensors:
  - sensor.rainbird_sprinkle_total_amount_today_front_lawn
  - sensor.rainbird_sprinkle_total_amount_today_side_lawn
  - sensor.exterior_living_room_rainbird_sprinkle_total_amount_today_station_3
calendar_weather: weather.openweathermap
calendar_rain_probability: 50
```

- Past days use Home Assistant hourly long-term statistics (the `state` value at the
  end of each hour). These can be retained indefinitely, independently of Recorder's
  raw-history retention. The latest observation before local midnight determines the
  day's total. Today's amounts come directly from the current sensor states.
- Sensors without long-term statistics fall back to Recorder's available raw history,
  for whatever retention that installation uses. Missing readings remain unknown,
  rather than being interpreted as zero.
- The weather entity supplies its *daily* forecast through the Home Assistant weather
  forecast API. Markers require an available precipitation probability at or above
  the configured percentage. Forecast availability and horizon depend on the provider.
- Markers are informational only; they do not alter the integration's irrigation
  decisions. Rain totals from this integration are weather-provider estimates, not
  measurements from a physical rain gauge.
- Tap a calendar day to open its detail panel; tap again to close it. Past dates show
  recorded rain and irrigation per station, while future dates show forecast rain
  probability (when available) and scheduled watering minutes per station.
- The simplified legend uses exactly the same rain and sprinkler icons as the grid.

### Irrigation Schedule

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
header: false
```

To show a heading, use `header: true`. An optional `title: Irrigation Schedule` overrides the friendly name. The card loads the controller schedule from the sensor's attributes, supports month selection, days between cycles, multiple watering times and duration per station. **Save updates the real controller schedule.**

What the editor reads from the sensor's attributes:

| Attribute | Used for | If missing |
| --- | --- | --- |
| `schedule` | the twelve months to edit (`hours`, `stations`, `interval_days`) | the card shows "Loading schedule data..." |
| `service_prefix` | the service to call on Save, `set_irrigation_schedule_<prefix>` | taken from the sensor's entity id when it has the form `sensor.<mac>_...` |
| `num_stations` | how many station rows to offer, so a month with nothing stored can still be configured | the length of `station_names`, then the highest station stored in the schedule |
| `station_names` | the labels of the station rows | `Station 1`, `Station 2`, ... |

`num_stations` and `station_names` are published by Smart Water Controller 1.1.3.

#### Optional month calendar

Off by default. Add `calendar: true` to draw the selected month under the editor with the days that water marked:

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
calendar: true
# next_schedule: sensor.rainbird_next_schedule   # only if the card cannot find it
```

**It is a projection, not a plan.** `interval_days` is not a fixed grid: Smart Water Controller waters a day only when at least that many days have passed since the later of the last rain and the last sprinkle, so rain resets the countdown. The calendar projects forward from that anchor *assuming the weather does not change*; a rain moves the later days, and a rain forecast can still shorten or skip a watering that is shown. For the current month it is anchored on real data ("Projected"); for any other month, or when no anchor is published, it only shows the pattern of the rule from the 1st and says so. Days before today are never marked, and today follows the integration's own verdict (`blocked_today`).

It was checked against the integration itself: `tests/fixtures/generate_from_integration.py` runs Smart Water Controller's `recent_event_blocks_today()` day by day over 360 scenarios and `npm test` requires the card to agree with every one of them.

It reads these attributes of the controller's **next schedule** sensor, published by [Smart Water Controller 1.1.2](https://github.com/hcraveiro/Home-Assistant-Smart-Water-Controller/releases/tag/v1.1.2) and newer:

| Attribute | Used for | If missing |
| --- | --- | --- |
| `interval_anchor` | the day the interval counts from (the later of the last rain and sprinkle) | `last_sprinkle`, then `last_rain`; without any the calendar shows only the pattern |
| `blocked_today` | whether today is on hold, as decided by the integration | today is derived from the anchor |
| `blocked_until` | the end of a hold, shown in the note | nothing is shown |
| `has_watering_slots` | finding the sensor when it cannot be derived | see below |

The sensor is the one named by `next_schedule`, else the sibling of the configured sensor (`..._controller_status` becomes `..._next_schedule`), else the only sensor that publishes `has_watering_slots`. With several controllers and no `next_schedule` the card does not guess.

#### Optional "Copy this month"

Off by default. Add `copy_month: true` to show a section that reuses the selected month (its times, minutes per station and interval) in the rest of the year or in all other months, instead of filling in twelve months by hand.

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
copy_month: true
```

It never writes anything on its own. Pressing **Copy** only asks: the confirmation names the months it would overwrite and how many of them already have times. **Overwrite** changes the card, not the controller: the card is marked "Unsaved changes" and nothing is sent until **Save**; **Reload** discards the copy. Changing month closes a pending confirmation, so a copy meant for one month cannot be confirmed on another.

While there are unsaved edits the card shows an "Unsaved changes" badge and a Reload button. If the schedule changes in Home Assistant in the meantime, it says so: saving would overwrite that change, and Reload discards your edits instead. A time that is typed twice in a month is flagged, because the integration counts each one as a watering slot of its own.

## Tested migration

The `v2.0.0-beta.1` HACS prerelease was installed and the existing `Utilities / irri` view rendered all bundled cards successfully with **only the HACS resource enabled**. Schedule edits were verified in both directions between the original and bundled card, zone operation was tested, and the desktop click issue was retested after fixing excessive DOM rerenders. This is a user-tested setup, not an automated end-to-end compatibility guarantee.

## Development

Sources (four readable modules, edited directly; there is no minified copy):
- `src/smart-water-controller-schedule-card.js`
- `src/schedule-style.js`
- `src/overview-card.js`
- `src/zones-card.js`

Build from the repository root with Node.js:

```sh
npm ci
npm run build
```

This generates `smart-water-controller-schedule-card.js`, the single HACS resource, by concatenating the four modules in that order. The script checks individual source files and the bundle with `node --check`. Commit the regenerated bundle together with the source change.

```sh
npm run check
```

`npm run check` is also run by CI. It fails if two clean builds differ, if the bundle does not register all three card elements (`smart-water-controller-schedule-card`, `irrigation-summary-card`, `irrigation-zones-card`), if it is a webpack output instead of the concatenated sources, or if the committed bundle is not what a clean build produces. When adding a card, add its element name to `expectedElements` in `scripts/check-build.js`.

```sh
npm test
```

`npm test` runs the schedule card tests in `tests/` with Node's built-in test runner. They load the real `src/smart-water-controller-schedule-card.js` into a jsdom window and drive it the way the Home Assistant frontend does (a `hass` object with the controller sensor, typed input, clicks). Node 20 or newer is enough; `jsdom` is the only dependency. CI runs them on every change to `src/`, `scripts/` or `tests/`.

`npm run watch` runs webpack for the schedule card alone and writes to `dist/` (ignored by git). It never touches the HACS bundle.

See [TESTING.md](TESTING.md) for isolated `-dev` testing, [UNIFIED-CARDS.md](UNIFIED-CARDS.md) for architecture, and [BETA-RELEASE-NOTES.md](BETA-RELEASE-NOTES.md) for prerelease notes.

## Updating and rollback

For upgrades, select the desired release in HACS, reload the browser (on desktop, `Ctrl + Shift + R`) and verify the three card types. To roll back, select a previously working HACS release via **Redownload** and reload. If returning to a release containing only the Schedule Card, restore the standalone Overview and Zones resources before using those cards.
