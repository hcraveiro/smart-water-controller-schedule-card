'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/smart-water-controller-schedule-card.js'), 'utf8');
const selected = source.split('.cal-cell.selected {')[1]?.split('}')[0] || '';
const today = source.split('.cal-cell.today {')[1]?.split('}')[0] || '';
const legend = source.split('.cal-swatch.today {')[1]?.split('}')[0] || '';
test('selected uses a filled background, not today border', () => {
  assert.ok(selected.includes('background: color-mix(in srgb, var(--primary-text-color) 17%'));
  assert.ok(!selected.includes('var(--primary-color)'));
  assert.ok(!selected.includes('border-color'));
  assert.ok(!selected.includes('outline:'));
});
test('today outline and legend remain consistent even when a day is selected', () => {
  assert.ok(today.includes('outline: 2px solid var(--primary-color)'));
  assert.ok(legend.includes('border: 2px solid var(--primary-color)'));
});

test('selection glow animates softly and respects reduced motion', () => {
  assert.ok(source.includes('@keyframes selected-day-glow'));
  assert.ok(source.includes('animation: selected-day-glow 2.8s ease-in-out infinite'));
  assert.ok(source.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(source.includes('animation: none'));
});

test('historical and projected station mini-cards use equal bar heights', () => {
  const actual = source.split('.cal-detail-track {')[1]?.split('}')[0] || '';
  const projected = source.split('.cal-detail-track.is-projected {')[1]?.split('}')[0] || '';
  const station = source.split('.cal-detail-station {')[1]?.split('}')[0] || '';
  assert.match(actual, /height:\s*9px/);
  assert.match(projected, /height:\s*9px/);
  assert.match(projected, /box-sizing:\s*border-box/);
  assert.match(station, /display:\s*flex/);
  assert.match(station, /flex-direction:\s*column/);
  assert.ok(source.includes('projected-fill'));
});

test('selected-day tablet cards have identical fixed height and mobile fallback', () => {
  const card = source.split('.cal-detail-station {')[1]?.split('}')[0] || '';
  const mobile = source.split('@media (max-width: 350px)')[1] || '';
  assert.match(card, /height:\s*82px/);
  assert.match(card, /box-sizing:\s*border-box/);
  assert.match(card, /justify-content:\s*space-between/);
  assert.match(mobile, /height:\s*auto;\s*min-height:\s*82px/);
  assert.ok(!source.includes('.cal-details-projected .cal-detail-station { height:'));
});

test('Schedule Card rainfall and forecast summaries use natural compact height', () => {
  const rain = source.split('.cal-detail-rain {')[1]?.split('}')[0] || '';
  assert.doesNotMatch(rain, /min-height/);
  assert.match(rain, /padding:\s*7px 11px/);
  assert.match(rain, /box-sizing:\s*border-box/);
  assert.ok(source.includes('Forecast may change this projection'));
  assert.ok(source.includes('Recorded precipitation'));
});
