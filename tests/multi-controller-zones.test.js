'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function cardFixture() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const window = dom.window;
  window.eval(fs.readFileSync(path.resolve(__dirname, '../src/zones-card.js'), 'utf8'));
  window.confirm = () => true;
  const calls = [];
  const states = {
    'sensor.rb_status': {state:'Stopped'},
    'sensor.bushes_status': {state:'Stopped'},
    'number.rb_duration': {state:'5',attributes:{min:1,max:30,step:1}},
    'number.bushes_duration': {state:'10',attributes:{min:1,max:60,step:1}},
    'sensor.rb_end': {state:'unknown'},
    'sensor.bushes_end': {state:'unknown'},
    'switch.rb_connection': {state:'on'}
  };
  const card = new (window.customElements.get('irrigation-zones-card'))();
  card.setConfig({
    duration:'number.rb_duration',
    end_time:'sensor.rb_end',
    stop:'button.rb_stop',
    connection_switches:['switch.rb_connection'],
    zones:[
      {name:'Front Lawn',controller:'rainbird',status:'sensor.rb_status',duration:'number.rb_duration',start:'button.rb_start',stop:'button.rb_stop'},
      {name:'Bushes',controller:'solem',status:'sensor.bushes_status',duration:'number.bushes_duration',end_time:'sensor.bushes_end',stop:'button.bushes_stop',start:'button.bushes_start',connection_switches:[]}
    ]
  });
  card.hass = {states,callService:async (domain,service,data)=>calls.push({domain,service,data})};
  return {window,card,states,calls,close:()=>dom.window.close()};
}

test('mixed controllers use different duration entities and stop targets', async () => {
  const f = cardFixture();
  try {
    assert.equal(f.card.duration(f.card.config.zones[0]),5);
    assert.equal(f.card.duration(f.card.config.zones[1]),10);
    f.states['sensor.rb_status'].state='Sprinkling';
    assert.doesNotThrow(()=>f.card.start(f.card.config.zones[1]));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.calls.at(-1)?.data.entity_id,'button.bushes_start');
    await f.card.stopAll(f.card.config.zones[1]);
    assert.equal(f.calls.at(-1)?.data.entity_id,'button.bushes_stop');
  } finally {f.close();}
});

test('another controller can run while a Rain Bird zone is active, but not two zones of the same controller', () => {
  const f=cardFixture();
  try {
    f.states['sensor.rb_status'].state='Sprinkling';
    assert.equal(f.card.groupZones(f.card.config.zones[1]).length,1);
    assert.equal(f.card.groupZones(f.card.config.zones[0]).length,1);
    f.card.render();
    assert.equal(f.card.shadowRoot.querySelectorAll('[data-stop-all]').length,1);
    assert.match(f.card.shadowRoot.innerHTML,/Stop All/);
  } finally {f.close();}
});

test('legacy single-controller configuration retains global stop', () => {
  const f=cardFixture();
  try {
    f.card.config.zones.forEach(z=>delete z.controller);
    f.states['sensor.rb_status'].state='Sprinkling';
    f.card.render();
    assert.match(f.card.shadowRoot.innerHTML,/data-stop-all/);
  } finally {f.close();}
});

test('Stop All appears beside an active zone, even while collapsed in multi-controller mode', async () => {
  const f=cardFixture();
  try {
    f.states['sensor.rb_status']={state:'Sprinkling',attributes:{irrigation_source:'manual_cycle'}};
    f.card.hass={states:f.states,callService:async (domain,service,data)=>f.calls.push({domain,service,data})};
    const button=f.card.shadowRoot.querySelector('.zone.running [data-stop-all]');
    assert.ok(button,'active station must expose Stop All without expanding');
    button.click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(f.calls.at(-1)?.data.entity_id,'button.rb_stop');
  } finally {f.close();}
});

test('Stop Station uses only a per-station button; never silently falls back to Stop All', async () => {
  const f=cardFixture();
  try {
    f.states['sensor.rb_status']={state:'Sprinkling',attributes:{irrigation_source:'manual_cycle'}};
    f.card.hass={states:f.states,callService:async (domain,service,data)=>f.calls.push({domain,service,data})};
    f.card.openZone=0;
    f.card.render();
    assert.equal(f.card.shadowRoot.querySelectorAll('.zone.running [data-action]').length,0);

    f.card.config.zones[0].stop_station='button.rb_stop_zone';
    f.states['button.rb_stop_zone']={state:'unknown'};
    f.card.hass={states:f.states,callService:async (domain,service,data)=>f.calls.push({domain,service,data})};
    const stationButton=f.card.shadowRoot.querySelector('.zone.running [data-action]');
    assert.ok(stationButton);
    assert.match(stationButton.textContent,/Stop Station/);
    stationButton.click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(f.calls.at(-1)?.data.entity_id,'button.rb_stop_zone');
    assert.notEqual(f.calls.at(-1)?.data.entity_id,'button.rb_stop');
  } finally {f.close();}
});

test('multiple controllers cannot accidentally stop another controller via fallback', () => {
  const f=cardFixture();
  try {
    delete f.card.config.zones[1].stop;
    f.states['sensor.bushes_status']={state:'Sprinkling'};
    f.card.hass={states:f.states};
    assert.equal(f.card.shadowRoot.querySelectorAll('.zone.running [data-stop-all]').length,0);
  } finally {f.close();}
});
