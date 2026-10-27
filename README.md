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
