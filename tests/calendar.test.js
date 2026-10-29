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

test('historical calendar uses recorded rain and station amounts instead of projected dots', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true,
    calendar_history: true,
    calendar_rain_sensor: 'sensor.daily_rain',
    calendar_station_sensors: ['sensor.station_1', 'sensor.station_2']
  }));
  card._historyByDay = { '2026-06-18': {
    'sensor.daily_rain': 1.7,
    'sensor.station_1': 2.1,
    'sensor.station_2': 0
  } };
  atToday('2026-06-19', () => card.render());
  const day = cells(card).find(cell => Number(cell.querySelector('.cal-day').textContent) === 18);
  assert.match(day.innerHTML, /mdi:water/);
  assert.match(day.innerHTML, /mdi:sprinkler/);
  assert.match(day.title, /Rain: 1.70 mm/);
  assert.match(day.title, /2.10 mm/);
  assert.ok(!day.classList.contains('waters'));
});

test('future weather marker requires probability at the configured threshold', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_weather: 'weather.openweathermap', calendar_rain_probability: 50
  }));
  card._dailyForecast = [
    { datetime: '2026-06-20T12:00:00', precipitation_probability: 49 },
    { datetime: '2026-06-21T12:00:00', precipitation_probability: 50 }
  ];
  atToday('2026-06-19', () => card.render());
  const byDay = day => cells(card).find(cell => Number(cell.querySelector('.cal-day').textContent) === day);
  assert.doesNotMatch(byDay(20).innerHTML, /mdi:water/);
  assert.match(byDay(21).innerHTML, /mdi:water/);
  assert.match(byDay(21).title, /50%/);
});

test('past marker visibility remains disabled by default', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true }));
  card._historyByDay = { '2026-06-18': { 'sensor.daily_rain': 3 } };
  card.render();
  assert.equal(card.shadowRoot.querySelectorAll('.cal-icons').length, 0);
});

test('historical missing sensor values are explicitly unknown', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_rain_sensor: 'sensor.daily_rain',
    calendar_station_sensors: ['sensor.station_1']
  }));
  card._historyByDay = { '2026-06-18': { 'sensor.station_1': 2.1 } };
  atToday('2026-06-19', () => card.render());
  const day = cells(card).find(cell => Number(cell.querySelector('.cal-day').textContent) === 18);
  assert.match(day.title, /Rain: unknown/);
  assert.match(day.title, /2.10 mm/);
  assert.doesNotMatch(day.innerHTML, /mdi:water/);
});

test('forecast calendar dates are not shifted by timezone offsets', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_weather: 'weather.openweathermap'
  }));
  card._dailyForecast = [{ datetime: '2026-06-21T00:00:00+14:00', precipitation_probability: 75 }];
  atToday('2026-06-19', () => card.render());
  const byDay = day => cells(card).find(cell => Number(cell.querySelector('.cal-day').textContent) === day);
  assert.match(byDay(21).innerHTML, /mdi:water/);
  assert.doesNotMatch(byDay(20).innerHTML, /mdi:water/);
});

test('hourly long-term statistics preserve end-of-day cumulative readings', async () => {
  const { card, hass } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_rain_sensor: 'sensor.daily_rain',
    calendar_station_sensors: ['sensor.station_1']
  }));
  hass.callWS = async (message) => {
    assert.equal(message.type, 'recorder/statistics_during_period');
    assert.equal(message.period, 'hour');
    assert.equal([...message.types].join(','), 'state,mean');
    return {
      'sensor.daily_rain': [
        { start: Date.parse('2026-06-18T22:00:00Z'), end: Date.parse('2026-06-18T23:00:00Z'), state: 5.83 },
        { start: Date.parse('2026-06-18T23:00:00Z'), end: Date.parse('2026-06-19T00:00:00Z'), state: 5.83 }
      ],
      'sensor.station_1': [
        { start: Date.parse('2026-06-18T23:00:00Z'), end: Date.parse('2026-06-19T00:00:00Z'), state: 4.2 }
      ]
    };
  };
  card._historyKey = 'fixture-statistics';
  await atToday('2026-06-19', () => card._readCalendarStatistics(
    card._calendarSourceIds(),
    new window.Date(2026, 5, 1),
    new window.Date(2026, 5, 19),
    card._historyKey
  ));
  assert.equal(card._historyByDay?.['2026-06-18']?.['sensor.daily_rain'], 5.83, JSON.stringify(card._historyByDay));
  atToday('2026-06-19', () => card.render());
  const day = cells(card).find(cell => Number(cell.querySelector('.cal-day').textContent) === 18);
  assert.match(day.title, /5.83 mm/);
  assert.match(day.title, /4.20 mm/);
});

test('today uses live sensor values instead of delayed hourly statistics', () => {
  const { card, hass } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_rain_sensor: 'sensor.daily_rain',
    calendar_station_sensors: ['sensor.station_1']
  }));
  hass.states['sensor.daily_rain'] = { state: '0.7' };
  hass.states['sensor.station_1'] = { state: '2.1' };
  const observed = atToday('2026-06-19', () => card._calendarObservations(2026, 5, 19));
  assert.equal(observed.rain, 0.7);
  assert.equal(observed.watered, true);
});

test('calendar history shows the current month, three months forward, and eight months back', () => {
  const { card } = atToday('2026-10-27', () => makeCard({
    calendar: true, calendar_history: true
  }));
  const years = atToday('2026-10-27', () => Array.from({ length: 12 }, (_, month) => {
    card.currentMonth = month;
    return card._getDisplayYear();
  }));
  assert.deepEqual(years, [
    2027, 2026, 2026, 2026, 2026, 2026,
    2026, 2026, 2026, 2026, 2026, 2026
  ]);
  card.currentMonth = 7;
  atToday('2026-10-27', () => card.render());
  assert.match(card.shadowRoot.textContent, /Calendar August 2026/);
  assert.equal(card.shadowRoot.querySelectorAll('.cal-cell.waters').length, 0);
});

test('January calendar window crosses the year without turning September into a future month', () => {
  const { card } = atToday('2026-12-15', () => makeCard({
    calendar: true, calendar_history: true
  }));
  const years = atToday('2026-12-15', () => [0, 1, 2, 3, 8, 10, 11].map(month =>
    card._getDisplayYear(month)
  ));
  assert.deepEqual(years, [2027, 2027, 2027, 2026, 2026, 2026, 2026]);
});

test('enhanced legend uses the same icons as the calendar and omits redundant past note', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true, calendar_history: true }));
  const legend = card.shadowRoot.querySelector('.cal-legend');
  assert.match(legend.innerHTML, /mdi:water/);
  assert.match(legend.innerHTML, /mdi:sprinkler/);
  assert.doesNotMatch(legend.textContent, /past: actual recorded values/);
});

test('selecting a past day reveals actual sensor totals and selecting again closes it', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_rain_sensor: 'sensor.daily_rain',
    calendar_station_sensors: ['sensor.station_1']
  }));
  card._historyByDay = { '2026-06-18': {
    'sensor.daily_rain': 5.83, 'sensor.station_1': 4.2
  } };
  atToday('2026-06-19', () => card.render());
  const getDay = () => cells(card).find(cell => Number(cell.querySelector('.cal-day').textContent) === 18);
  atToday('2026-06-19', () => getDay().click());
  assert.match(card.shadowRoot.querySelector('.cal-day-details').textContent, /5.83 mm/);
  assert.match(card.shadowRoot.querySelector('.cal-day-details').textContent, /4.20 \/ No data mm/);
  atToday('2026-06-19', () => getDay().click());
  assert.equal(card.shadowRoot.querySelector('.cal-day-details'), null);
});

test('no projected irrigation displays the sprinkler icon in selected-day details', () => {
  const { card } = atToday('2026-11-24', () => makeCard({
    calendar: true, calendar_history: true,
  }));
  atToday('2026-11-24', () => {
    card.currentMonth = 10;
    card._selectedCalendarDay = 24;
    card.render();
  });
  const empty = card.shadowRoot.querySelector('.cal-detail-empty');
  assert.ok(empty);
  assert.match(empty.textContent, /No irrigation currently projected/);
  assert.equal(empty.querySelector('ha-icon')?.getAttribute('icon'), 'mdi:sprinkler-variant');
});

test('selecting a future watering day uses mm and never invents a missing projected rate', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true, calendar_history: true }));
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 21;
    card.render();
  });
  const details = card.shadowRoot.querySelector('.cal-day-details');
  assert.ok(details);
  assert.match(details.textContent, /Projected irrigation/);
  assert.match(details.textContent, /No plan data/);
  assert.doesNotMatch(details.textContent, /minutes planned/);
  assert.doesNotMatch(details.textContent, /Rainfall:/);
});


test('auto-discovers historic planned sensor with the existing actual naming convention', () => {
  const actual = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const target = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const { card, hass } = atToday('2026-10-29', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_rain_sensor: 'sensor.rain_today',
    calendar_station_sensors: [actual]
  }));
  assert.ok(card._calendarSourceIds().includes(target));
  card._historyByDay = {
    '2026-10-28': { [actual]: 4.2, [target]: 4.2, 'sensor.rain_today': 0 },
    '2026-10-29': { [actual]: 1, [target]: 4, 'sensor.rain_today': 3 }
  };
  hass.states[actual] = { state: '2.69' };
  hass.states[target] = { state: '4.2' };
  hass.states['sensor.rain_today'] = { state: '0' };
  atToday('2026-10-29', () => {
    card.currentMonth = 9;
    card._selectedCalendarDay = 28;
    card.render();
  });
  let text = card.shadowRoot.querySelector('.cal-day-details').textContent;
  assert.match(text, /Actual \/ Planned/);
  assert.match(text, /4.20 \/ 4.20 mm/);
  card._selectedCalendarDay = 29;
  atToday('2026-10-29', () => card.render());
  text = card.shadowRoot.querySelector('.cal-day-details').textContent;
  assert.match(text, /2.69 \/ 4.20 mm/);
  assert.equal(card.shadowRoot.querySelector('.cal-detail-rain-value').textContent, '0.00 mm');
});

test('statistics use mean for measurement targets and state for actual water', async () => {
  const actual = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const target = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const { card, hass } = atToday('2026-10-29', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: [actual],
  }));
  hass.callWS = async (message) => {
    assert.deepEqual([...message.types], ['state', 'mean']);
    assert.ok(message.statistic_ids.includes(actual));
    assert.ok(message.statistic_ids.includes(target));
    const end = Date.parse('2026-10-29T00:00:00Z');
    return {
      [actual]: [{ end, state: 2.69, mean: null }],
      [target]: [{ end, state: null, mean: 4.2 }]
    };
  };
  card._historyKey = 'mm-history-test';
  await card._readCalendarStatistics(
    card._calendarSourceIds(), new window.Date(2026, 9, 28),
    new window.Date(2026, 9, 29), card._historyKey,
  );
  assert.equal(card._historyByDay['2026-10-28'][actual], 2.69);
  assert.equal(card._historyByDay['2026-10-28'][target], 4.2);
});

test('past missing planned statistics are unknown, not copied from current schedule', () => {
  const actual = 'sensor.station_1';
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: [actual],
  }));
  card._historyByDay = { '2026-06-18': { [actual]: 2.1 } };
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 18;
    card.render();
  });
  assert.match(card.shadowRoot.querySelector('.cal-day-details').textContent,
    /2.10 \/ No data mm/);
});

test('future projected mm use live planned target and current month schedule ratio', () => {
  const actual = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const target = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const { card, hass } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: [actual],
  }));
  hass.states[target] = { state: '8.4' };
  // Two daily slots * 10 minutes each = 20 minutes => 0.42 mm/min.
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 21;
    card.render();
  });
  const details = card.shadowRoot.querySelector('.cal-day-details').textContent;
  assert.match(details, /8.40 mm/);
  assert.doesNotMatch(details, /minutes planned/);
});

test('future forecast may use an explicit rate when today is blocked by rain', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: ['sensor.station_1'],
    calendar_station_mm_per_minute: [0.42],
  }));
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 21;
    card.render();
  });
  assert.match(card.shadowRoot.querySelector('.cal-day-details').textContent,
    /8.40 mm/);
});


test('historical selected-day details use mini-cards with accurate solid progress bars', () => {
  const actual1 = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const actual2 = 'sensor.rainbird_sprinkle_total_amount_today_side_lawn';
  const target1 = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const target2 = 'sensor.rainbird_forecasted_sprinkle_today_side_lawn';
  const { card, hass } = atToday('2026-10-29', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_rain_sensor: 'sensor.rain_today',
    calendar_station_sensors: [actual1, actual2],
  }));
  hass.states[actual1] = { state: '2.69' };
  hass.states[target1] = { state: '4.20' };
  hass.states[actual2] = { state: '2.39' };
  hass.states[target2] = { state: '4.20' };
  hass.states['sensor.rain_today'] = { state: '0' };
  atToday('2026-10-29', () => {
    card.currentMonth = 9;
    card._selectedCalendarDay = 29;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.ok(panel.classList.contains('cal-details-actual'));
  assert.equal(panel.querySelectorAll('.cal-detail-station').length, 2);
  assert.match(panel.querySelector('.cal-detail-date').textContent, /October 29, 2026/);
  assert.equal(panel.querySelector('.cal-detail-status').textContent, 'Actual / Planned');
  assert.deepEqual([...panel.querySelectorAll('.cal-detail-amount')].map(item => item.textContent),
    ['2.69 / 4.20 mm', '2.39 / 4.20 mm']);
  const bars = [...panel.querySelectorAll('.cal-detail-track')];
  assert.equal(bars[0].getAttribute('role'), 'progressbar');
  assert.equal(bars[0].getAttribute('aria-valuenow'), '64');
  assert.equal(bars[0].querySelector('.actual-fill').style.width, '64%');
  assert.equal(bars[1].getAttribute('aria-valuenow'), '57');
  assert.equal(bars[1].querySelector('.actual-fill').style.width, '57%');
  assert.deepEqual([...panel.querySelectorAll('.cal-detail-station-foot span:last-child')].map(x => x.textContent),
    ['64% applied', '57% applied']);
  assert.equal(panel.querySelector('.cal-detail-rain-title').textContent, 'Rainfall');
  assert.equal(panel.querySelector('.cal-detail-rain-value').textContent, '0.00 mm');
});

test('future selected-day details have striped preview bars and forecast rain card', () => {
  const actual = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const planned = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const { card, hass } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: [actual]
  }));
  hass.states[planned] = { state: '8.4' };
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 21;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.ok(panel.classList.contains('cal-details-projected'));
  assert.equal(panel.querySelector('.cal-detail-status').textContent, 'Projected irrigation');
  assert.equal(panel.querySelector('.cal-detail-station').querySelector('.cal-detail-amount').textContent, '8.40 mm');
  const bar = panel.querySelector('.cal-detail-track.is-projected');
  assert.ok(bar);
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.ok(bar.querySelector('.projected-fill'));
  assert.equal(panel.querySelector('.cal-detail-station-foot span:last-child').textContent, 'Planned · Pending');
  assert.equal(panel.querySelector('.cal-detail-rain-title').textContent, 'Rain forecast');
  assert.equal(panel.querySelector('.cal-detail-rain-value').textContent, 'No rain above threshold');
  assert.equal(panel.querySelectorAll('.actual-fill').length, 0);
  assert.doesNotMatch(panel.textContent, /\b100% applied\b|minutes planned|mm projected/);
});

test('unknown historical plan never shows a false progress percentage', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true, calendar_station_sensors: ['sensor.station_1']
  }));
  card._historyByDay = { '2026-06-18': { 'sensor.station_1': 2.1 } };
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 18;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.equal(panel.querySelector('.cal-detail-amount').textContent, '2.10 / No data mm');
  assert.equal(panel.querySelector('.cal-detail-station-foot span:last-child').textContent, 'Progress unavailable');
  assert.equal(panel.querySelector('.cal-detail-track').getAttribute('role'), null);
  assert.equal(panel.querySelector('.actual-fill').style.width, '0%');
});

test('projected watering with unknown rate shows empty dashed bar, not fabricated amount', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true, calendar_station_sensors: ['sensor.station_1']
  }));
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 21;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.ok(panel.querySelector('.projected-fill.no-data'));
  assert.equal(panel.querySelector('.cal-detail-amount').textContent, 'No plan data');
  assert.equal(panel.querySelector('.cal-detail-station-foot span:last-child').textContent, 'Projection unavailable');
});

test('selected-day mini-cards escape station names from Home Assistant', () => {
  const { card } = atToday('2026-06-19', () => makeCard({
    calendar: true, calendar_history: true, calendar_station_sensors: ['sensor.station_1']
  }, { attributes: { station_names: ['<img src=x onerror=alert(1)>'] } }));
  card._historyByDay = { '2026-06-18': { 'sensor.station_1': 2.1 } };
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 18;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.match(panel.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(panel.querySelector('.cal-detail-station img'), null);
});


test('historical irrigation beyond planned target caps displayed percentage but retains mm', () => {
  const actual = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const planned = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const { card } = atToday('2026-10-29', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: [actual]
  }));
  card._historyByDay = { '2026-10-03': { [actual]: 2.14, [planned]: 0.04 } };
  atToday('2026-10-29', () => {
    card.currentMonth = 9;
    card._selectedCalendarDay = 3;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.equal(panel.querySelector('.cal-detail-amount').textContent, '2.14 / 0.04 mm');
  assert.equal(panel.querySelector('.cal-detail-station-foot span:last-child').textContent, '100% applied');
  assert.equal(panel.querySelector('.cal-detail-track').getAttribute('aria-valuenow'), '100');
  assert.equal(panel.querySelector('.actual-fill').style.width, '100%');
  assert.doesNotMatch(panel.textContent, /5350%/);
});

test('historical watering above a zero target says watered without planned target', () => {
  const actual = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const planned = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const { card } = atToday('2026-10-29', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: [actual]
  }));
  card._historyByDay = { '2026-10-03': { [actual]: 2.14, [planned]: 0 } };
  atToday('2026-10-29', () => {
    card.currentMonth = 9;
    card._selectedCalendarDay = 3;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.equal(panel.querySelector('.cal-detail-amount').textContent, '2.14 / 0.00 mm');
  assert.equal(panel.querySelector('.cal-detail-station-foot span:last-child').textContent,
    'Watered without planned target');
  assert.equal(panel.querySelector('.cal-detail-track').getAttribute('role'), null);
  assert.equal(panel.querySelector('.actual-fill').style.width, '0%');
});

test('historical zero watering with zero target shows no irrigation planned', () => {
  const actual = 'sensor.rainbird_sprinkle_total_amount_today_front_lawn';
  const planned = 'sensor.rainbird_forecasted_sprinkle_today_front_lawn';
  const { card } = atToday('2026-10-29', () => makeCard({
    calendar: true, calendar_history: true,
    calendar_station_sensors: [actual]
  }));
  card._historyByDay = { '2026-10-03': { [actual]: 0, [planned]: 0 } };
  atToday('2026-10-29', () => {
    card.currentMonth = 9;
    card._selectedCalendarDay = 3;
    card.render();
  });
  const panel = card.shadowRoot.querySelector('.cal-day-details');
  assert.equal(panel.querySelector('.cal-detail-amount').textContent, '0.00 / 0.00 mm');
  assert.equal(panel.querySelector('.cal-detail-station-foot span:last-child').textContent,
    'No irrigation planned');
});

test('calendar day cells have selection state without marking empty cells', () => {
  const { card } = atToday('2026-06-19', () => makeCard({ calendar: true, calendar_history: true }));
  atToday('2026-06-19', () => {
    card._selectedCalendarDay = 18;
    card.render();
  });
  const chosen = cells(card).find(cell => Number(cell.querySelector('.cal-day').textContent) === 18);
  assert.ok(chosen.classList.contains('selected'));
  assert.ok(!chosen.classList.contains('today'));
  assert.ok(card.shadowRoot.querySelector('.cal-cell.today'));
  assert.equal(card.shadowRoot.querySelectorAll('.cal-cell.empty.selected').length, 0);
});
