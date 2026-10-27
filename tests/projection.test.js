'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadWindow, plain } = require('./helpers');

const window = loadWindow();
test.after(() => window.close());

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'integration-projection.json'), 'utf8')
);

const HOURS = ['07:00:00'];
const date = iso => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
};
const wateringDays = result => result.days.filter(entry => entry.waters).map(entry => entry.day);

function project(options) {
  return plain(window.projectWateringDays({ hours: HOURS, ...options }));
}

// The expected days were computed by Smart Water Controller itself (see
// tests/fixtures/generate_from_integration.py): the fixture walks each month
// day by day through the integration's own recent_event_blocks_today().

test('the projection agrees with the integration, day by day, in every scenario', () => {
  assert.ok(fixture.scenarios.length >= 300);

  for (const scenario of fixture.scenarios) {
    const result = project({
      year: scenario.year,
      monthIndex: scenario.monthIndex,
      intervalDays: scenario.intervalDays,
      anchor: date(scenario.anchor),
      today: date(scenario.today),
      blockedToday: scenario.blockedToday
    });

    assert.equal(result.mode, 'projected');
    assert.deepEqual(
      wateringDays(result),
      scenario.waters,
      `anchor ${scenario.anchor}, today ${scenario.today}, every ${scenario.intervalDays} day(s)`
    );
  }
});

test('the scenarios cover both a blocked and an open day today', () => {
  assert.ok(fixture.scenarios.some(scenario => scenario.blockedToday));
  assert.ok(fixture.scenarios.some(scenario => !scenario.blockedToday));
});

test('no day before today is ever marked', () => {
  const result = project({
    year: 2026,
    monthIndex: 5,
    intervalDays: 2,
    anchor: date('2026-06-10'),
    today: date('2026-06-19'),
    blockedToday: false
  });

  assert.ok(result.days.every(entry => !entry.isPast || !entry.waters));
});

test('the verdict of the integration for today wins over the arithmetic', () => {
  // Two days since the anchor would say "waters"; the integration says it is on hold.
  const blocked = project({
    year: 2026,
    monthIndex: 5,
    intervalDays: 2,
    anchor: date('2026-06-17'),
    today: date('2026-06-19'),
    blockedToday: true
  });

  assert.deepEqual(wateringDays(blocked), [20, 22, 24, 26, 28, 30]);
  assert.equal(blocked.days.find(entry => entry.day === 19).blocked, true);
});

test('a month with no times waters on no day', () => {
  const result = project({
    year: 2026,
    monthIndex: 5,
    hours: [],
    intervalDays: 2,
    anchor: date('2026-06-17'),
    today: date('2026-06-19')
  });

  assert.deepEqual(wateringDays(result), []);
});

test('without an anchor it only shows the pattern of the rule, from the 1st', () => {
  const result = project({
    year: 2026,
    monthIndex: 5,
    intervalDays: 3,
    anchor: null,
    today: date('2026-10-26')
  });

  assert.equal(result.mode, 'pattern');
  assert.deepEqual(wateringDays(result), [1, 4, 7, 10, 13, 16, 19, 22, 25, 28]);
});

test('another month than the current one is a pattern even when an anchor is known', () => {
  const result = project({
    year: 2026,
    monthIndex: 5,
    intervalDays: 2,
    anchor: date('2026-10-24'),
    today: date('2026-10-26')
  });

  assert.equal(result.mode, 'pattern');
});

// What the card cannot know is the weather. The same month, with one rain on
// the 22nd, waters on different days from then on. The projection matches the
// run at unchanged weather, which is what the card says next to the calendar.

test('a rain moves the later days, and the projection is the run without it', () => {
  const example = fixture.rainExample;
  const result = project({
    year: example.year,
    monthIndex: example.monthIndex,
    intervalDays: example.intervalDays,
    anchor: date(example.anchor),
    today: date(example.today),
    blockedToday: false
  });

  assert.deepEqual(wateringDays(result), example.unchangedWeather);
  assert.notDeepEqual(example.withRainOn22, example.unchangedWeather);
});
