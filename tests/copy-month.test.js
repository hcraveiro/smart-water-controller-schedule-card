'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWindow, juneSchedule, makeCard, plain } = require('./helpers');

const window = loadWindow();
test.after(() => window.close());

const JUNE = { hours: ['07:00:00', '21:00:00'], stations: { station_1_minutes: 10, station_2_minutes: 5 }, interval_days: 2 };
const EMPTY = { hours: [], stations: {}, interval_days: 0 };

const root = card => card.shadowRoot;
const click = (card, action) => root(card).querySelector(`[data-action='${action}']`).click();
const chooseTarget = (card, value) => {
  root(card).querySelector("[data-role='copy-target']").value = value;
};
const confirmBar = card => root(card).querySelector('.confirm-bar');
// Month names follow the locale of the machine, and the markup has indentation.
const text = node => node.textContent.replace(/\s+/g, ' ').trim();
const june = card => card._formatMonthName(5);

function copyCard(attributes = {}) {
  return makeCard(window, { schedule: juneSchedule(), num_stations: 2, ...attributes }, { copy_month: true });
}

test('"Copy this month" is off unless the dashboard asks for it', () => {
  const { card } = makeCard(window, { schedule: juneSchedule() });

  assert.equal(root(card).querySelector("[data-role='copy-target']"), null);
  assert.equal(card.getCardSize(), 7);
});

test('nothing is copied until the copy is confirmed, and cancelling changes nothing', () => {
  const { card } = copyCard();
  assert.equal(confirmBar(card), null);

  chooseTarget(card, 'rest');
  click(card, 'request-copy');
  assert.ok(confirmBar(card), 'no confirmation was asked');
  assert.equal(text(confirmBar(card)).startsWith(`Overwrite the remaining 6 months of the year with ${june(card)}?`), true, text(confirmBar(card)));
  assert.deepEqual(plain(card.scheduleData[6]), EMPTY);

  click(card, 'cancel-copy');
  assert.equal(confirmBar(card), null);
  assert.deepEqual(plain(card.scheduleData[6]), EMPTY);
  assert.equal(card._isDirty, false);
});

test('confirming copies to the rest of the year only, and marks the card unsaved', () => {
  const { card, hass } = copyCard();

  chooseTarget(card, 'rest');
  click(card, 'request-copy');
  click(card, 'confirm-copy');

  assert.deepEqual(plain(card.scheduleData[6]), JUNE);
  assert.deepEqual(plain(card.scheduleData[11]), JUNE);
  assert.deepEqual(plain(card.scheduleData[4]), EMPTY, 'a month before June was changed');
  assert.equal(card._isDirty, true);
  assert.equal(text(root(card).querySelector("[data-role='status']")), `Copied ${june(card)} to 6 months. Not saved yet.`);
  assert.equal(hass.calls.length, 0, 'the copy was sent to Home Assistant without Save');
});

test('"all other months" covers the twelve months', () => {
  const { card } = copyCard();

  chooseTarget(card, 'all');
  click(card, 'request-copy');
  click(card, 'confirm-copy');

  const same = card.scheduleData.filter(month => JSON.stringify(plain(month)) === JSON.stringify(JUNE));
  assert.equal(same.length, 12);
});

test('the copies are independent of the month they came from', () => {
  const { card } = copyCard();

  chooseTarget(card, 'rest');
  click(card, 'request-copy');
  click(card, 'confirm-copy');
  card.scheduleData[6].hours.push('12:00:00');
  card.scheduleData[6].stations.station_1_minutes = 99;

  assert.equal(card.scheduleData[5].hours.length, 2);
  assert.equal(card.scheduleData[5].stations.station_1_minutes, 10);
});

test('the confirmation says how many of the months it replaces already have times', () => {
  const months = juneSchedule();
  months[6] = { hours: ['06:00:00'], stations: { station_1_minutes: 3 }, interval_days: 1 };
  months[8] = { hours: ['05:00:00'], stations: {}, interval_days: 0 };
  const { card } = makeCard(window, { schedule: months, num_stations: 2 }, { copy_month: true });

  chooseTarget(card, 'rest');
  click(card, 'request-copy');
  assert.match(text(confirmBar(card)), /2 of them already have times/);

  click(card, 'cancel-copy');
  const clean = copyCard();
  chooseTarget(clean.card, 'rest');
  click(clean.card, 'request-copy');
  assert.doesNotMatch(text(confirmBar(clean.card)), /already/);
});

test('changing month closes a pending confirmation', () => {
  const { card } = copyCard();

  chooseTarget(card, 'rest');
  click(card, 'request-copy');
  assert.ok(confirmBar(card));

  click(card, 'next-month');
  assert.equal(confirmBar(card), null);
  assert.deepEqual(plain(card.scheduleData[6]), EMPTY);
});

test('Save sends the copied months, and Reload discards the copy', async () => {
  const saved = copyCard();
  chooseTarget(saved.card, 'rest');
  click(saved.card, 'request-copy');
  click(saved.card, 'confirm-copy');
  await saved.card._saveSchedule();
  assert.deepEqual(plain(saved.hass.calls[0].data.schedule[6].hours), ['07:00:00', '21:00:00']);

  const reloaded = copyCard();
  chooseTarget(reloaded.card, 'rest');
  click(reloaded.card, 'request-copy');
  click(reloaded.card, 'confirm-copy');
  click(reloaded.card, 'reload-schedule');
  assert.deepEqual(plain(reloaded.card.scheduleData[6]), EMPTY);
  assert.equal(confirmBar(reloaded.card), null);
});
