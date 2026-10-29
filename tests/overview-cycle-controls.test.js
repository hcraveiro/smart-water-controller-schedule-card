'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

function fixture(multi = true) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {runScripts:'outside-only'});
  dom.window.confirm = () => true;
  dom.window.alert = () => {};
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../src/overview-card.js'), 'utf8'));
  const card = new (dom.window.customElements.get('irrigation-summary-card'))();
  const lawn = {
    name:'Lawn',controller:'sensor.rainbird_controller_status',
    station:'sensor.rainbird_current_irrigation_station',
    next:'sensor.rainbird_next_schedule',last:'sensor.rainbird_last_sprinkle',
    end:'sensor.rainbird_irrigation_end_time',
    zone_statuses:['sensor.rainbird_front_lawn_status_1'],connection_switches:['switch.rain_bird_sprinkler_1']
  };
  const bushes = {
    name:'Bushes',controller:'sensor.solem_bushes_controller_status',
    station:'sensor.solem_bushes_current_irrigation_station',
    next:'sensor.solem_bushes_next_schedule',last:'sensor.solem_bushes_last_sprinkle',
    end:'sensor.solem_bushes_irrigation_end_time',
    zone_statuses:['sensor.solem_bushes_bushes_status'],connection_switches:[]
  };
  card.setConfig(multi ? {mode:'overview',controllers:[lawn,bushes]} : {mode:'overview', ...lawn});
  const schedule=(...minutes) => Array.from({length:12},()=>({
    hours:['08:00:00'],stations:Object.fromEntries(minutes.map((v,i)=>[`station_${i+1}_minutes`,v])),interval_days:1
  }));
  const calls=[];
  const states={
    'sensor.rainbird_controller_status':{state:'On',attributes:{friendly_name:'Rainbird Controller Status',irrigation_source:null,schedule:schedule(5,5,5)}},
    'sensor.solem_bushes_controller_status':{state:'On',attributes:{friendly_name:'Bushes Controller Status',irrigation_source:null,schedule:schedule(10)}},
    'sensor.rainbird_front_lawn_status_1':{state:'Stopped'},
    'sensor.solem_bushes_bushes_status':{state:'Stopped'},
    'sensor.rainbird_current_irrigation_station':{state:'Idle'},
    'sensor.solem_bushes_current_irrigation_station':{state:'Idle'},
    'sensor.rainbird_next_schedule':{state:new Date(Date.now()+3600000).toISOString()},
    'sensor.rainbird_last_sprinkle':{state:new Date(Date.now()-3600000).toISOString()},
    'sensor.solem_bushes_next_schedule':{state:new Date(Date.now()+3600000).toISOString()},
    'sensor.solem_bushes_last_sprinkle':{state:new Date(Date.now()-3600000).toISOString()},
    'sensor.rainbird_irrigation_end_time':{state:new Date(Date.now()+120000).toISOString()},
    'sensor.solem_bushes_irrigation_end_time':{state:new Date(Date.now()+120000).toISOString()},
    'switch.rain_bird_sprinkler_1':{state:'off'},
    'button.exterior_living_room_rainbird_run_cycle':{state:'unknown',attributes:{friendly_name:'Rainbird Run Cycle'}},
    'button.exterior_living_room_bushes_run_cycle':{state:'unknown',attributes:{friendly_name:'Bushes Run Cycle'}},
    'button.rainbird_stop_sprinkle':{state:'unknown',attributes:{friendly_name:'Rainbird Stop sprinkle'}},
    'button.solem_bushes_stop_sprinkle':{state:'unknown',attributes:{friendly_name:'Bushes Stop sprinkle'}}
  };
  function update() {
    card.hass={states,callService:async (domain,service,data) => calls.push({domain,service,data})};
  }
  update();
  return {dom,card,states,calls,update};
}

function active(f, controller, zone, source) {
  f.states[zone]={state:'Sprinkling',attributes:{irrigation_source:source}};
  f.states[controller]={...f.states[controller],attributes:{...f.states[controller].attributes,irrigation_source:source}};
  f.update();
}

test('Overview preserves all four controller indicators and shows configured cycle durations',()=>{
  const f=fixture();
  try {
    const sections=f.card.shadowRoot.querySelectorAll('.controller-section');
    assert.equal(sections.length,2);
    for(const section of sections) {
      for(const label of ['Next irrigation','Last irrigation','Current station','Controller']) {
        assert.ok(section.textContent.includes(label));
      }
    }
    assert.match(sections[0].textContent,/3 stations · 15 min total/);
    assert.match(sections[1].textContent,/1 station · 10 min total/);
    assert.equal(f.card.shadowRoot.querySelectorAll('[data-cycle-action="run_cycle"]').length,2);
  }finally{f.dom.window.close();}
});

test('Run Cycle executes the intended controller only with confirmation',async()=>{
  const f=fixture();
  try {
    const buttons=f.card.shadowRoot.querySelectorAll('[data-cycle-action="run_cycle"]');
    buttons[0].click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{domain:'button',service:'press',data:{entity_id:'button.exterior_living_room_rainbird_run_cycle'}});
    f.card.shadowRoot.querySelectorAll('[data-cycle-action="run_cycle"]')[1].click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])),{domain:'button',service:'press',data:{entity_id:'button.exterior_living_room_bushes_run_cycle'}});
    const count=f.calls.length;
    f.dom.window.confirm=()=>false;
    f.card.shadowRoot.querySelector('[data-cycle-action="run_cycle"]').click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(f.calls.length,count);
  }finally{f.dom.window.close();}
});

test('manual individual watering shows no Stop All or Run Cycle buttons',()=>{
  const f=fixture();
  try {
    active(f,'sensor.rainbird_controller_status','sensor.rainbird_front_lawn_status_1','manual');
    assert.match(f.card.shadowRoot.innerHTML,/Manual watering active|Manual watering/);
    assert.match(f.card.shadowRoot.innerHTML,/Stop the station from Irrigation Zones/);
    const sections=f.card.shadowRoot.querySelectorAll('.controller-section');
    assert.equal(sections[0].querySelectorAll('[data-cycle-action]').length,0);
    assert.equal(sections[1].querySelector('[data-cycle-action]')?.dataset.cycleAction,'run_cycle');
  }finally{f.dom.window.close();}
});

test('manual and scheduled cycles show Stop All for exactly the active controller',async()=>{
  const f=fixture();
  try {
    active(f,'sensor.rainbird_controller_status','sensor.rainbird_front_lawn_status_1','manual_cycle');
    let sections=f.card.shadowRoot.querySelectorAll('.controller-section');
    assert.equal(sections[0].querySelector('[data-cycle-action]')?.dataset.cycleAction,'stop');
    assert.equal(sections[1].querySelector('[data-cycle-action]')?.dataset.cycleAction,'run_cycle');
    sections[0].querySelector('[data-cycle-action]').click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(f.calls.at(-1)?.data.entity_id,'button.rainbird_stop_sprinkle');
    f.states['sensor.rainbird_front_lawn_status_1']={state:'Stopped'};
    f.states['sensor.rainbird_controller_status'].attributes.irrigation_source=null;
    active(f,'sensor.solem_bushes_controller_status','sensor.solem_bushes_bushes_status','automatic');
    sections=f.card.shadowRoot.querySelectorAll('.controller-section');
    assert.equal(sections[0].querySelector('[data-cycle-action]')?.dataset.cycleAction,'run_cycle');
    assert.equal(sections[1].querySelector('[data-cycle-action]')?.dataset.cycleAction,'stop');
    sections[1].querySelector('[data-cycle-action]').click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(f.calls.at(-1)?.data.entity_id,'button.solem_bushes_stop_sprinkle');
  }finally{f.dom.window.close();}
});

test('single-controller Overview retains all indicators and gets Run Cycle and Stop All',()=>{
  const f=fixture(false);
  try {
    assert.equal(f.card.shadowRoot.querySelectorAll('.overview-grid .chip').length,4);
    assert.equal(f.card.shadowRoot.querySelector('[data-cycle-action]')?.dataset.cycleAction,'run_cycle');
    active(f,'sensor.rainbird_controller_status','sensor.rainbird_front_lawn_status_1','automatic');
    assert.equal(f.card.shadowRoot.querySelector('[data-cycle-action]')?.dataset.cycleAction,'stop');
    assert.equal(f.card.shadowRoot.querySelectorAll('.overview-grid .chip').length,4);
  }finally{f.dom.window.close();}
});

test('unavailable or ambiguous actions do not control the wrong controller',()=>{
  const f=fixture();
  try {
    delete f.states['button.exterior_living_room_rainbird_run_cycle'];
    f.update();
    const button=f.card.shadowRoot.querySelector('.controller-section [data-cycle-action]');
    assert.equal(button?.disabled,true);
    f.states['button.a_rainbird_run_cycle']={state:'unknown',attributes:{friendly_name:'Rainbird Run Cycle'}};
    f.states['button.b_rainbird_run_cycle']={state:'unknown',attributes:{friendly_name:'Rainbird Run Cycle'}};
    f.update();
    assert.equal(f.card.shadowRoot.querySelector('.controller-section [data-cycle-action]')?.disabled,true);
    f.states['sensor.rainbird_controller_status']={state:'unavailable',attributes:f.states['sensor.rainbird_controller_status'].attributes};
    f.update();
    assert.equal(f.card.shadowRoot.querySelector('.controller-section [data-cycle-action]')?.disabled,true);
  }finally{f.dom.window.close();}
});
