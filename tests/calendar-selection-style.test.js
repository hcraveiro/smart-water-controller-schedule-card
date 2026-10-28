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
