'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

function fixture() {
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{runScripts:'outside-only'});
  dom.window.eval(fs.readFileSync(path.join(__dirname,'../src/overview-card.js'),'utf8'));
  const card=new (dom.window.customElements.get('irrigation-summary-card'))();
  card.setConfig({mode:'overview',controllers:[
    {name:'Rain Bird',controller:'sensor.rb_controller',station:'sensor.rb_station',next:'sensor.rb_next',last:'sensor.rb_last',end:'sensor.rb_end',zone_statuses:['sensor.rb_zone'],connection_switches:['switch.rb']},
    {name:'Solem Bushes',controller:'sensor.solem_controller',station:'sensor.solem_station',next:'sensor.solem_next',last:'sensor.solem_last',end:'sensor.solem_end',zone_statuses:['sensor.solem_zone'],connection_switches:[]}
  ]});
  const now=Date.now();
  const states={
    'sensor.rb_controller':{state:'On'},'sensor.solem_controller':{state:'Off'},'switch.rb':{state:'on'},
    'sensor.rb_zone':{state:'Stopped'},'sensor.solem_zone':{state:'Stopped'},
    'sensor.rb_station':{state:'Idle'},'sensor.solem_station':{state:'Idle'},
    'sensor.rb_next':{state:new Date(now+3600000).toISOString()},
    'sensor.solem_next':{state:new Date(now+7200000).toISOString()},
    'sensor.rb_last':{state:new Date(now-7200000).toISOString()},
    'sensor.solem_last':{state:new Date(now-3600000).toISOString()},
    'sensor.rb_end':{state:new Date(now+600000).toISOString()},
    'sensor.solem_end':{state:new Date(now+900000).toISOString()}
  };
  card.hass={states};
  return {dom,card,states};
}

test('multi-controller overview shows earliest next, latest last and two separate sections',()=>{
  const {dom,card}=fixture();
  try {
    const html=card.shadowRoot.innerHTML;
    assert.match(html,/1 On · 1 Off/);
    assert.match(html,/In 1 h/);
    assert.match(html,/Solem Bushes/);
    assert.equal((html.match(/class="controller-section"/g)||[]).length,2);
    assert.match(html,/Idle/);
  } finally {dom.window.close();}
});

test('controller sections start expanded and collapse independently',()=>{
  const {dom,card}=fixture();
  try {
    const headers=card.shadowRoot.querySelectorAll('[data-controller-toggle]');
    assert.equal(headers.length,2);
    assert.equal(card.shadowRoot.querySelectorAll('.controller-section .overview-grid').length,2);
    assert.equal(card.shadowRoot.querySelectorAll('[aria-expanded="true"]').length,2);
    headers[0].click();
    assert.equal(card.shadowRoot.querySelectorAll('.controller-section .overview-grid').length,1);
    card.shadowRoot.querySelectorAll('[data-controller-toggle]')[1].click();
    assert.equal(card.shadowRoot.querySelectorAll('.controller-section .overview-grid').length,0);
    card.shadowRoot.querySelectorAll('[data-controller-toggle]')[0].click();
    assert.equal(card.shadowRoot.querySelectorAll('.controller-section .overview-grid').length,1);
  } finally {dom.window.close();}
});

test('unavailable controller is not counted as Off',()=>{
  const {dom,card,states}=fixture();
  try {
    states['sensor.solem_controller']={state:'unavailable'};
    card.hass={states};
    assert.match(card.shadowRoot.innerHTML,/1 Unavailable/);
    assert.doesNotMatch(card.shadowRoot.innerHTML,/1 Off/);
  } finally {dom.window.close();}
});

test('simultaneous irrigation renders independent countdowns',()=>{
  const {dom,card,states}=fixture();
  try {
    states['sensor.rb_zone']={state:'Sprinkling'};
    states['sensor.solem_zone']={state:'Sprinkling'};
    card.hass={states};
    assert.match(card.shadowRoot.innerHTML,/Irrigation running/);
    assert.equal(card.shadowRoot.querySelectorAll('[data-live-controller]').length,2);
  } finally {dom.window.close();}
});

test('legacy single-controller overview still renders without controller sections',()=>{
  const {dom,card,states}=fixture();
  try {
    card.setConfig({mode:'overview'});
    card.hass={states};
    assert.equal(card.shadowRoot.querySelectorAll('.controller-section').length,0);
    assert.match(card.shadowRoot.innerHTML,/Next irrigation/);
  } finally {dom.window.close();}
});
