# Home Assistant Smart Water Controller Schedule Card

[![hacs_badge](https://img.shields.io/badge/HACS-Default-41BDF5.svg)](https://github.com/hacs/integration)
[![GitHub release](https://img.shields.io/github/release/hcraveiro/Home-Assistant-Smart-Water-Controller-Schedule-Card.svg)](https://github.com/hcraveiro/Home-Assistant-Smart-Water-Controller-Schedule-Card/releases/)

Configure the watering schedule of your Smart Water Controller integration directly from your Home Assistant dashboard.

- [Home Assistant Smart Water Controller Schedule Card](#home-assistant-smart-water-controller-schedule-card)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Header options](#header-options)
  - [What the card edits](#what-the-card-edits)
  - [FAQ](#faq)

## Installation

This card can be installed through HACS like any other Lovelace card.

Alternatively, you can manually download the `.js` file from the repository, place it in your `www` folder, and add it as a dashboard resource:

```yaml
resources:
  - url: /local/smart-water-controller-schedule-card.js
    type: module
```

When installed through HACS, restart Home Assistant so the card becomes available.

## Configuration

To use this card, you must already have the [Smart Water Controller](https://github.com/hcraveiro/Home-Assistant-Smart-Water-Controller) integration installed and at least one configured controller.

Add one card per controller as a manual card:

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.<config_entry_name>_controller_status
```

Example:

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
```

## Header options

The card supports an optional header.

By default, the header is hidden:

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
```

To show the header using the controller entity friendly name:

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
header: true
```

To show the header with a custom title:

```yaml
type: custom:smart-water-controller-schedule-card
sensor: sensor.rainbird_controller_status
header: true
title: Irrigation Schedule
```

### Header behaviour

- `header` is optional and defaults to `false`
- when `header: true` and `title` is set, the custom title is shown
- when `header: true` and `title` is not set, the entity `friendly_name` is shown
- if no `friendly_name` is available, the card falls back to `Irrigation schedule`

## What the card edits

The card allows you to configure the monthly watering schedule for the selected controller.

For each month, you can configure:

- **Interval between sprinkles**  
  The number of days between watering cycles.

- **Scheduled times**  
  One or more times for each watering day in that month.

- **Sprinkle time per station**  
  The watering duration in minutes for each station.

If your Smart Water Controller integration has station names configured, the card will display those names instead of generic labels such as `Station 1`, `Station 2`, etc.

After making changes, click **Save** to persist the updated schedule in the Smart Water Controller integration.

## FAQ

### Do I need one card per controller?

Yes.  
Each card is linked to a single controller status sensor.

### Can I hide the title?

Yes.  
The header is hidden by default. Only set `header: true` if you want it shown.

### Can I use a custom title?

Yes.  
Set both:

```yaml
header: true
title: Irrigation Schedule
```

### Why do I see `Station 1` / `Station 2` instead of custom station names?

The card shows custom station names when they are exposed by the Smart Water Controller integration on the controller status sensor attributes.

### Do I need to save after editing?

Yes.  
Changes made in the card are only persisted after clicking **Save**.
