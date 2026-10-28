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
    await Promise.resolve();
    assert.equal(f.calls.at(-1)?.data.entity_id,'button.bushes_start');
    await f.card.stop('Bushes',f.card.config.zones[1]);
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
    assert.doesNotMatch(f.card.shadowRoot.innerHTML,/data-stop-all/);
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
