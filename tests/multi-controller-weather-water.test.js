'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
function makeCard(config) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {runScripts:'outside-only'});
  dom.window.eval(fs.readFileSync(path.join(__dirname,'../src/overview-card.js'),'utf8'));
  const card = new (dom.window.customElements.get('irrigation-summary-card'))();
  card.setConfig(config);
  card.hass = {states: {
    'sensor.rainbird_total_water_consumption': {state:'79094.56',attributes:{unit_of_measurement:'L'}},
    'sensor.solem_bushes_total_water_consumption': {state:'84.5',attributes:{unit_of_measurement:'L'}}
  }};
  return {dom,card};
}
test('Weather renders labeled irrigation totals from different controllers', () => {
  const {dom,card} = makeCard({mode:'weather',water_sensors:[
    {name:'Rain Bird',entity:'sensor.rainbird_total_water_consumption'},
    {name:'Solem Bushes',entity:'sensor.solem_bushes_total_water_consumption'}
  ]});
  try {
    const html=card.shadowRoot.innerHTML;
    assert.match(html,/Total irrigation water \(Rain Bird\)/);
    assert.match(html,/Total irrigation water \(Solem Bushes\)/);
    assert.match(html,/79,094.56 L/);
    assert.match(html,/84.50 L/);
    assert.equal(card._trackedIds.includes('sensor.solem_bushes_total_water_consumption'),true);
    assert.equal(card.shadowRoot.querySelectorAll('.weather-bottom .detail-row').length,3);
  } finally {dom.window.close();}
});
test('legacy Weather keeps one irrigation water row', () => {
  const {dom,card} = makeCard({mode:'weather'});
  try {
    const html=card.shadowRoot.innerHTML;
    assert.match(html,/Total irrigation water/);
    assert.doesNotMatch(html,/Total irrigation water \(Rain Bird\)/);
    assert.equal(card.shadowRoot.querySelectorAll('.weather-bottom .detail-row').length,2);
  } finally {dom.window.close();}
});
