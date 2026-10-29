'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

function loadCard(file, element) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {runScripts:'outside-only'});
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));
  return {dom, card: new (dom.window.customElements.get(element))()};
}

function overviewFixture(source = 'manual_cycle') {
  const {dom, card} = loadCard('overview-card.js', 'irrigation-summary-card');
  card.setConfig({mode:'overview'});
  const states = {
    'sensor.rainbird_controller_status': {state:'On', attributes:{irrigation_source:source}},
    'sensor.rainbird_current_irrigation_station': {state:'Front Lawn 1'},
    'sensor.rainbird_front_lawn_status_1': {state:'Sprinkling', attributes:{irrigation_source:source}},
    'sensor.rainbird_front_lawn_status_2': {state:'Stopped'},
    'sensor.rainbird_side_lawn_status': {state:'Stopped'},
    'sensor.rainbird_irrigation_end_time': {state:new Date(Date.now()+180000).toISOString()},
    'switch.rain_bird_sprinkler_1': {state:'on'},
    'switch.rain_bird_sprinkler_2': {state:'off'},
    'switch.rain_bird_sprinkler_3': {state:'off'}
  };
  card.hass={states};
  return {dom,card,states};
}

test('single-controller overview identifies manual cycle and current-station countdown', () => {
  const f=overviewFixture();
  try {
    assert.match(f.card.shadowRoot.innerHTML, /Manual cycle running/);
    assert.match(f.card.shadowRoot.innerHTML, /Station ends in/);
    assert.match(f.card.shadowRoot.innerHTML, /Front Lawn 1/);
    assert.doesNotMatch(f.card.shadowRoot.innerHTML, /Stopping in/);
  } finally {f.dom.window.close();}
});

test('overview supports other known sources and gracefully handles missing source', () => {
  const f=overviewFixture('automatic');
  try {
    assert.match(f.card.shadowRoot.innerHTML, /Scheduled watering/);
    assert.match(f.card.shadowRoot.innerHTML, /Stopping in/);
    f.states['sensor.rainbird_controller_status']={state:'On',attributes:{irrigation_source:'manual'}};
    f.states['sensor.rainbird_front_lawn_status_1']={state:'Sprinkling',attributes:{irrigation_source:'manual'}};
    f.card.hass={states:f.states};
    assert.match(f.card.shadowRoot.innerHTML, /Manual watering/);
    f.states['sensor.rainbird_controller_status']={state:'On',attributes:{}};
    f.states['sensor.rainbird_front_lawn_status_1']={state:'Sprinkling',attributes:{irrigation_source:'external'}};
    f.card.hass={states:f.states};
    assert.match(f.card.shadowRoot.innerHTML, /External watering/);
    f.states['sensor.rainbird_front_lawn_status_1']={state:'Sprinkling',attributes:{}};
    f.card.hass={states:f.states};
    assert.match(f.card.shadowRoot.innerHTML, /Irrigation running/);
    assert.doesNotMatch(f.card.shadowRoot.innerHTML, /Station ends in/);
  } finally {f.dom.window.close();}
});

test('multi-controller overview identifies source per controller, including simultaneous watering', () => {
  const {dom,card}=loadCard('overview-card.js','irrigation-summary-card');
  try {
    card.setConfig({mode:'overview',controllers:[
      {name:'Rain Bird',controller:'sensor.rb_controller',station:'sensor.rb_station',next:'sensor.rb_next',last:'sensor.rb_last',end:'sensor.rb_end',zone_statuses:['sensor.rb_zone'],connection_switches:[]},
      {name:'Bushes',controller:'sensor.bush_controller',station:'sensor.bush_station',next:'sensor.bush_next',last:'sensor.bush_last',end:'sensor.bush_end',zone_statuses:['sensor.bush_zone'],connection_switches:[]}
    ]});
    const end=new Date(Date.now()+180000).toISOString();
    const states={
      'sensor.rb_controller':{state:'On',attributes:{irrigation_source:'manual_cycle'}},
      'sensor.rb_zone':{state:'Sprinkling'},
      'sensor.rb_station':{state:'Front Lawn 1'},
      'sensor.rb_end':{state:end},
      'sensor.bush_controller':{state:'On',attributes:{irrigation_source:'automatic'}},
      'sensor.bush_zone':{state:'Sprinkling'},
      'sensor.bush_station':{state:'Bushes'},
      'sensor.bush_end':{state:end}
    };
    card.hass={states};
    assert.match(card.shadowRoot.innerHTML,/Irrigation running/);
    assert.match(card.shadowRoot.innerHTML,/Manual cycle/);
    assert.match(card.shadowRoot.innerHTML,/Scheduled watering/);
    assert.equal(card.shadowRoot.querySelectorAll('[data-live-controller]').length,2);
    assert.match(card.shadowRoot.innerHTML,/Station ends in/);
    states['sensor.bush_zone']={state:'Stopped'};
    card.hass={states};
    assert.match(card.shadowRoot.innerHTML,/Manual cycle running/);
  } finally {dom.window.close();}
});

test('zones shows source only for the active station and clarifies its countdown', () => {
  const {dom,card}=loadCard('zones-card.js','irrigation-zones-card');
  try {
    card.setConfig({
      connection_switches:[],
      zones:[
        {name:'Front Lawn 1',status:'sensor.zone_one'},
        {name:'Front Lawn 2',status:'sensor.zone_two'}
      ]
    });
    const states={
      'sensor.zone_one':{state:'Sprinkling',attributes:{irrigation_source:'manual_cycle'}},
      'sensor.zone_two':{state:'Stopped',attributes:{irrigation_source:null}},
      'sensor.rainbird_irrigation_end_time':{state:new Date(Date.now()+180000).toISOString()}
    };
    card.hass={states};
    assert.match(card.shadowRoot.innerHTML,/Station ends in/);
    assert.equal(card.shadowRoot.querySelectorAll('.zone .irrigation-source').length,1);
    assert.equal(card.shadowRoot.querySelector('.zone.running .irrigation-source')?.textContent,'Manual cycle');
    assert.equal(card.shadowRoot.querySelectorAll('.zone:not(.running) .irrigation-source').length,0);
    states['sensor.zone_one']={state:'Sprinkling',attributes:{irrigation_source:'automatic'}};
    card.hass={states};
    assert.equal(card.shadowRoot.querySelector('.zone.running .irrigation-source')?.textContent,'Scheduled watering');
    assert.match(card.shadowRoot.innerHTML,/Stopping in/);
    states['sensor.zone_one']={state:'Sprinkling',attributes:{}};
    card.hass={states};
    assert.equal(card.shadowRoot.querySelectorAll('.zone .irrigation-source').length,0);
  } finally {dom.window.close();}
});
