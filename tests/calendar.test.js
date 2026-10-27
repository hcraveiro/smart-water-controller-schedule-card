'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWindow, juneSchedule, makeHass, SENSOR } = require('./helpers');

const window = loadWindow();
test.after(() => window.close());

const NEXT = 'sensor.solem_next_schedule';
const RealDate = window.Date;

// The card asks the clock for "today". Pin it, in the window the card runs in.
function atToday(iso, run) {
  const [year, month, day] = iso.split('-').map(Number);
  const pinned = new RealDate(year, month - 1, day, 12, 0, 0);

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(pinned.getTime());
      } else {
        super(...args);
      }
    }

    static now() {
      return pinned.getTime();
    }
  }

  window.Date = FakeDate;
  try {
    return run();
  } finally {
    window.Date = RealDate;
  }
}

// The attributes Smart Water Controller 1.1.2 and newer publish on the
// "next schedule" sensor.
const published = (overrides = {}) => ({
  has_watering_slots: true,
  configured_months: ['June: 07:00:00 - 10 min on ZEN'],
  interval_days: 2,
  last_rain: '2026-06-10T18:00:00+02:00',
  last_sprinkle: '2026-06-09T07:00:00+02:00',
  interval_anchor: '2026-06-10T18:00:00+02:00',
  blocked_today: false,
  blocked_until: null,
  ...overrides
});

function makeCard(config, { next = published(), attributes = {} } = {}) {
  const card = new (window.customElements.get('smart-water-controller-schedule-card'))();
  window.document.body.appendChild(card);
  const hass = makeHass({
    service_prefix: 'c8_b9_61_d3_fa_0d',
    schedule: juneSchedule(),
    ...attributes
  });
  if (next) {
    hass.states[NEXT] = { entity_id: NEXT, state: 'unknown', attributes: next };
  }
  card.setConfig({ sensor: SENSOR, ...config });
  card.hass = hass;
  card.currentMonth = 5;
  card.render();
  return { card, hass };
}

const cells = card => [...card.shadowRoot.querySelectorAll('.cal-cell:not(.empty)')];
const watering = card => cells(card).filter(cell => cell.classList.contains('waters')).map(cell => Number(cell.textContent.trim()));
const note = card => card.shadowRoot.querySelector('.cal-note').textContent.replace(/\s+/g, ' ').trim();

test('the calendar is off unless the dashboard asks for it', () => {
  const { card } = atToday('2026-06-19', () => makeCard({}));

  assert.equal(card.shadowRoot.querySelector('.cal-grid'), null);
  assert.equal(card.getCardSize(), 7);
});

test('with calendar: true it draws the month and marks the days that water', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true }));

  assert.equal(cells(card).length, 30);
  // Anchored on the 10th, interval 2, nine days later: due today, then every other day.
  assert.deepEqual(watering(card), [19, 21, 23, 25, 27, 29]);
  assert.equal(card.shadowRoot.querySelector('.cal-cell.today').textContent.trim(), '19');
  assert.ok(card.getCardSize() > 7);
});

test('no day before today is marked', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true }));

  assert.equal(card.shadowRoot.querySelectorAll('.cal-cell.past.waters').length, 0);
});

test('the integration\'s verdict for today wins and the rest keeps its phase', () => {
  const { card } = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, { next: published({ interval_anchor: '2026-06-17T08:00:00+02:00', blocked_today: true }) })
  );

  assert.deepEqual(watering(card), [20, 22, 24, 26, 28, 30]);
  assert.ok(card.shadowRoot.querySelector('.cal-cell.today').classList.contains('blocked'));
});

test('it says what the days are: a projection at unchanged weather', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true }));

  assert.match(note(card), /Projected/);
  assert.match(note(card), /weather/);
  assert.match(note(card), /Rain resets the interval/);
  assert.match(note(card), /forecast/);
});

test('another month than the current one is shown as a pattern, not as a forecast', () => {
  const { card } = atToday('2026-10-26', () => makeCard({ calendar: true }));

  assert.match(note(card), /pattern/i);
  assert.doesNotMatch(note(card), /Projected/);
});

test('without the attributes it only claims the pattern of the rule', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true }, { next: null }));

  assert.match(note(card), /pattern/i);
  assert.match(note(card), /1\.1\.2/);
});

test('a month with no times, or with every station at 0, says that nothing waters', () => {
  const empty = atToday('2026-06-19', () => {
    const attributes = { schedule: juneSchedule() };
    attributes.schedule[5].hours = [];
    return makeCard({ calendar: true }, { attributes });
  });
  assert.match(note(empty.card), /No times/);
  assert.deepEqual(watering(empty.card), []);

  const zero = atToday('2026-06-19', () => {
    const attributes = { schedule: juneSchedule() };
    attributes.schedule[5].stations = { station_1_minutes: 0, station_2_minutes: 0 };
    return makeCard({ calendar: true }, { attributes });
  });
  assert.match(note(zero.card), /0 minutes/);
});

test('no day is marked while every station is at 0 minutes, whatever the note says', () => {
  const zero = atToday('2026-06-19', () => {
    const attributes = { schedule: juneSchedule() };
    attributes.schedule[5].stations = { station_1_minutes: 0, station_2_minutes: 0 };
    return makeCard({ calendar: true }, { attributes });
  });

  assert.deepEqual(watering(zero.card), []);
  assert.equal(zero.card.shadowRoot.querySelectorAll('.cal-cell .cal-dot').length, 0);
  assert.equal(zero.card.shadowRoot.querySelectorAll('.cal-cell.waters').length, 0);
  assert.match(note(zero.card), /0 minutes/);

  // One station with minutes is enough: it is the schedule the integration would run.
  const one = atToday('2026-06-19', () => {
    const attributes = { schedule: juneSchedule() };
    attributes.schedule[5].stations = { station_1_minutes: 0, station_2_minutes: 5 };
    return makeCard({ calendar: true }, { attributes });
  });
  assert.deepEqual(watering(one.card), [19, 21, 23, 25, 27, 29]);
});

test('no day is marked in the pattern view either when every station is at 0 minutes', () => {
  const { card } = atToday('2026-10-26', () => {
    const attributes = { schedule: juneSchedule() };
    attributes.schedule[5].stations = { station_1_minutes: 0, station_2_minutes: 0 };
    return makeCard({ calendar: true }, { attributes, next: null });
  });

  assert.deepEqual(watering(card), []);
});

// Without `interval_anchor` the card counts from the later of the last rain and
// the last sprinkle, which is what the scheduler does. `blocked_today: null`
// leaves today to the arithmetic, so the anchor is what decides the phase.
const withoutAnchor = overrides => published({ interval_anchor: null, blocked_today: null, ...overrides });

test('without the published anchor it counts from the rain when that is more recent', () => {
  const { card } = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, {
      next: withoutAnchor({ last_sprinkle: '2026-06-10T07:00:00+02:00', last_rain: '2026-06-18T16:00:00+02:00' })
    })
  );

  assert.deepEqual(watering(card), [20, 22, 24, 26, 28, 30]);
});

test('without the published anchor it counts from the sprinkle when that is more recent', () => {
  const { card } = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, {
      next: withoutAnchor({ last_sprinkle: '2026-06-18T07:00:00+02:00', last_rain: '2026-06-10T16:00:00+02:00' })
    })
  );

  assert.deepEqual(watering(card), [20, 22, 24, 26, 28, 30]);
});

test('without the published anchor it uses whichever of the two is a valid date', () => {
  const rainOnly = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, { next: withoutAnchor({ last_sprinkle: null, last_rain: '2026-06-18T16:00:00+02:00' }) })
  );
  const sprinkleOnly = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, { next: withoutAnchor({ last_sprinkle: '2026-06-18T07:00:00+02:00', last_rain: 'not a date' }) })
  );
  const neither = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, { next: withoutAnchor({ last_sprinkle: null, last_rain: null }) })
  );

  assert.deepEqual(watering(rainOnly.card), [20, 22, 24, 26, 28, 30]);
  assert.deepEqual(watering(sprinkleOnly.card), [20, 22, 24, 26, 28, 30]);
  assert.match(note(neither.card), /pattern/i);
});

test('the published anchor still wins over the two fallbacks', () => {
  const { card } = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, {
      next: published({ blocked_today: null, interval_anchor: '2026-06-17T08:00:00+02:00', last_sprinkle: '2026-06-18T07:00:00+02:00', last_rain: '2026-06-18T16:00:00+02:00' })
    })
  );

  assert.deepEqual(watering(card), [19, 21, 23, 25, 27, 29]);
});

test('it follows the anchor when it rains, without the schedule changing', () => {
  const { card, hass } = atToday('2026-06-19', () => makeCard({ calendar: true }));
  assert.deepEqual(watering(card), [19, 21, 23, 25, 27, 29]);

  hass.states[NEXT].attributes = published({
    interval_anchor: '2026-06-19T09:00:00+02:00',
    blocked_today: true
  });
  atToday('2026-06-19', () => {
    card.hass = hass;
  });

  assert.deepEqual(watering(card), [21, 23, 25, 27, 29]);
});

test('with calendar off, a change of anchor does not redraw the card', () => {
  const { card, hass } = atToday('2026-06-19', () => makeCard({}));
  const input = card.shadowRoot.querySelector("[data-role='station-minutes']");

  hass.states[NEXT].attributes = published({ interval_anchor: '2026-06-18T09:00:00+02:00' });
  card.hass = hass;

  assert.equal(card.shadowRoot.querySelector("[data-role='station-minutes']"), input);
});

test('it does not guess between several controllers', () => {
  const { card, hass } = atToday('2026-06-19', () => makeCard({ calendar: true }, { next: null }));
  hass.states['sensor.garden_a_next_schedule'] = { entity_id: 'sensor.garden_a_next_schedule', attributes: published() };
  hass.states['sensor.garden_b_next_schedule'] = { entity_id: 'sensor.garden_b_next_schedule', attributes: published() };
  atToday('2026-06-19', () => {
    card.hass = hass;
    card.render();
  });

  assert.match(note(card), /pattern/i);
});

test('next_schedule in the dashboard config names the sensor to read', () => {
  const { card } = atToday('2026-06-19', () => {
    const made = makeCard({ calendar: true, next_schedule: 'sensor.other_next_schedule' }, { next: null });
    made.hass.states['sensor.other_next_schedule'] = {
      entity_id: 'sensor.other_next_schedule',
      attributes: published()
    };
    made.card.hass = made.hass;
    made.card.render();
    return made;
  });

  assert.deepEqual(watering(card), [19, 21, 23, 25, 27, 29]);
});

test('calendar text coming from Home Assistant is shown as text', () => {
  const { card } = atToday('2026-06-19', () =>
    makeCard({ calendar: true }, { next: published({ blocked_until: '<img src=x onerror=alert(1)>' }) })
  );

  assert.match(note(card), /<img src=x onerror=alert\(1\)>/);
  assert.equal(card.shadowRoot.querySelectorAll('.cal-note img').length, 0);
});
