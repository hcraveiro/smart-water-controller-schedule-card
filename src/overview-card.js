/* RainBird summary cards: overview and weather. Version 1.0. */
class IrrigationSummaryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._expanded = false;
    this._expandedControllers = new Set();
    this._timer = null;
    this._commandBusy = false;
  }

  setConfig(config) {
    if (!['overview', 'weather'].includes(config.mode)) {
      throw new Error('Specify mode: overview or weather');
    }
    if (config.controllers !== undefined && (config.mode !== 'overview' || !Array.isArray(config.controllers) || !config.controllers.length)) throw new Error('controllers requires a non-empty array in overview mode');
    this._config = {
      controller: 'sensor.rainbird_controller_status',
      station: 'sensor.rainbird_current_irrigation_station',
      next: 'sensor.rainbird_next_schedule',
      last: 'sensor.rainbird_last_sprinkle',
      end: 'sensor.rainbird_irrigation_end_time',
      connection_switches: [
        'switch.rain_bird_sprinkler_1',
        'switch.rain_bird_sprinkler_2',
        'switch.rain_bird_sprinkler_3'
      ],
      zone_statuses: [
        'sensor.rainbird_front_lawn_status_1',
        'sensor.rainbird_front_lawn_status_2',
        'sensor.rainbird_side_lawn_status'
      ],
      raining: 'binary_sensor.rainbird_is_it_raining_now',
      rain_forecast: 'binary_sensor.rainbird_will_it_rain_today',
      rain_today: 'sensor.rainbird_total_amount_of_rain_today',
      forecast_today: 'sensor.rainbird_total_forecasted_rain_today',
      rain_duration: 'sensor.rainbird_rain_time_today',
      last_rain: 'sensor.rainbird_last_rain',
      water: 'sensor.rainbird_total_water_consumption',
      ...config
    };
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    const commandIds = (this._config?.controllers || (this._config?.mode === 'overview' ? [this._config] : []))
      .flatMap(controller => [this.actionEntity(controller, 'run_cycle'), this.actionEntity(controller, 'stop')]);
    const ids = [...Object.values(this._config || {}), ...((this._config?.controllers || []).flatMap(item => Object.values(item))), ...((this._config?.water_sensors || []).map(item => item.entity), ...commandIds]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter(value => typeof value === 'string' &&
        /^(sensor|binary_sensor|input_boolean|switch|button)\./.test(value));
    const current = ids.map(id => hass?.states?.[id]);
    if (this._trackedIds?.length === ids.length &&
        ids.every((id, index) =>
          id === this._trackedIds[index] &&
          current[index] === this._trackedEntities[index])) {
      this.updateLiveText();
      return;
    }
    this._trackedIds = ids;
    this._trackedEntities = current;
    this.render();
  }

  connectedCallback() {
    this._timer = setInterval(() => this.updateLiveText(), 1000);
    this.updateLiveText();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() { return this._config?.mode === 'overview' ? 3 : 3; }

  state(id) { return this._hass?.states?.[id]?.state ?? 'unavailable'; }
  entity(id) { return this._hass?.states?.[id]; }
  irrigationSource(config) {
    // Prefer controller attributes; older integrations may expose the source on stations.
    const ids = [config.controller, ...(config.zone_statuses || [])];
    for (const id of ids) {
      const source = this.entity(id)?.attributes?.irrigation_source;
      if (typeof source === 'string' && source.trim()) return source.trim().toLowerCase();
    }
    return null;
  }
  actionEntity(controller, action) {
    // Explicit mappings take precedence and are never guessed across controllers.
    const configured = action === 'run_cycle' ? controller.run_cycle : controller.stop;
    if (configured !== undefined) {
      return typeof configured === 'string' && this.entity(configured) ? configured : null;
    }
    const prefix = action === 'run_cycle' ? 'Run Cycle' : 'Stop sprinkle';
    const entity = this.entity(controller.controller);
    const friendly = String(entity?.attributes?.friendly_name || '').replace(/ Controller Status$/i, '').trim();
    const names = [friendly, controller.name].filter(Boolean).map(name => String(name).toLowerCase());
    const idPrefix = String(controller.controller || '').replace(/^sensor\./, '').replace(/_controller_status(?:_\d+)?$/, '');
    const aliases = [idPrefix, idPrefix.split('_').at(-1), ...names.map(name => name.replace(/[^a-z0-9]+/g, '_'))]
      .filter(value => value && value.length > 2);
    const suffix = action === 'run_cycle' ? '_run_cycle' : '_stop_sprinkle';
    const candidates = Object.entries(this._hass?.states || {})
      .filter(([id]) => id.startsWith('button.') && id.endsWith(suffix))
      .filter(([id, button]) => {
        const entityName = String(button.attributes?.friendly_name || '').toLowerCase();
        if (names.some(name => entityName === `${name} ${prefix.toLowerCase()}`)) return true;
        const base = id.slice('button.'.length, -suffix.length);
        return aliases.some(alias => base === alias || base.endsWith(`_${alias}`));
      }).map(([id]) => id);
    // Refuse ambiguous inferred mappings instead of stopping a different controller.
    return candidates.length === 1 ? candidates[0] : null;
  }
  cycleDuration(controller) {
    const schedule = this.entity(controller.controller)?.attributes?.schedule;
    const month = Array.isArray(schedule) ? schedule[new Date().getMonth()] : null;
    const minutes = Object.entries(month?.stations || {})
      .filter(([key]) => /^station_\d+_minutes$/.test(key))
      .map(([, value]) => Number(value))
      .filter(value => Number.isFinite(value) && value > 0);
    if (!minutes.length) return null;
    return {stations: minutes.length, totalMinutes: minutes.reduce((total, value) => total + value, 0)};
  }
  cycleAction(controller, active, source) {
    const isCycle = active && (source === 'manual_cycle' || source === 'automatic');
    const isManual = active && !isCycle;
    if (isManual) return `<div class="cycle-action neutral"><div class="cycle-copy"><strong>${this.escape(this.irrigationLabel(source) || 'Irrigation active')}</strong><small>Stop the station from Irrigation Zones</small></div></div>`;
    const duration = this.cycleDuration(controller);
    const run = this.actionEntity(controller, 'run_cycle');
    const stop = this.actionEntity(controller, 'stop');
    const controllerOn = this.state(controller.controller).toLowerCase() === 'on';
    const lost = (controller.connection_switches || []).some(id => !this.valid(this.state(id)));
    const disabled = this._commandBusy || lost || (isCycle ? !stop : !controllerOn || !run || !duration);
    const label = isCycle ? 'Stop All' : 'Run Cycle';
    const desc = isCycle ? 'Stop the complete irrigation cycle'
      : duration ? `${duration.stations} ${duration.stations === 1 ? 'station' : 'stations'} · ${duration.totalMinutes} min total`
        : 'No station durations configured this month';
    return `<div class="cycle-action ${isCycle ? 'cycle-stop' : 'cycle-ready'}">
      <div class="cycle-copy"><strong>${label}</strong><small>${this.escape(desc)}</small></div>
      <button class="cycle-button" data-cycle-action="${isCycle ? 'stop' : 'run_cycle'}" data-cycle-controller="${this.escape(controller.controller)}"
        ${disabled ? 'disabled' : ''}><ha-icon icon="mdi:${isCycle ? 'stop-circle-outline' : 'play'}"></ha-icon>${isCycle ? 'Stop All' : 'Start'}</button>
    </div>`;
  }
  async executeCycleAction(controllerId, action) {
    if (this._commandBusy || this._config?.mode !== 'overview') return;
    const controllers = this._config.controllers || [this._config];
    const controller = controllers.find(item => item.controller === controllerId);
    if (!controller) return;
    const states = (controller.zone_statuses || []).map(id => this.state(id).toLowerCase());
    const active = states.includes('sprinkling');
    const source = active ? this.irrigationSource(controller) : null;
    if (action === 'run_cycle' && (active || this.state(controller.controller).toLowerCase() !== 'on' || !this.cycleDuration(controller))) return;
    if (action === 'stop' && (!active || !['manual_cycle','automatic'].includes(source))) return;
    if ((controller.connection_switches || []).some(id => !this.valid(this.state(id)))) return;
    const target = this.actionEntity(controller, action);
    if (!target) return;
    const label = controller.name || this.entity(controller.controller)?.attributes?.friendly_name || controller.controller;
    const message = action === 'stop'
      ? `Stop the entire irrigation cycle on ${label}?`
      : `Run the complete configured watering cycle on ${label}, regardless of rainfall or water already applied?`;
    if (!confirm(message)) return;
    this._commandBusy = true;
    this.render();
    try {
      await this._hass.callService('button', 'press', {entity_id: target});
    } catch (error) {
      console.error('Failed to execute irrigation cycle command:', error);
      if (typeof alert === 'function') alert('Unable to execute irrigation command.');
    } finally {
      this._commandBusy = false;
      this.render();
    }
  }
  irrigationLabel(source) {
    return {
      automatic: 'Scheduled watering',
      manual: 'Manual watering',
      manual_cycle: 'Manual cycle',
      external: 'External watering'
    }[source] || null;
  }
  irrigationHeadline(source) {
    return source === 'manual_cycle' ? 'Manual cycle running'
      : this.irrigationLabel(source) || 'Irrigation running';
  }
  valid(value) { return !['unknown','unavailable','none',''].includes(String(value).toLowerCase()); }
  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }
  moreInfo(id) {
    if (!id) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      bubbles: true, composed: true, detail: {entityId:id}
    }));
  }
  timeSince(id) {
    const raw = this.state(id);
    if (!this.valid(raw)) return '—';
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) return raw;
    const seconds = Math.round((Date.now() - date) / 1000);
    if (seconds < 0) return this.timeUntil(id);
    if (seconds < 60) return `${seconds} seconds ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  }
  timeUntil(id) {
    const raw = this.state(id);
    if (!this.valid(raw)) return '—';
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) return raw;
    const seconds = Math.round((date - Date.now()) / 1000);
    if (seconds < 0) return 'Due now';
    if (seconds < 60) return 'In less than 1 min';
    if (seconds < 3600) return `In ${Math.ceil(seconds / 60)} min`;
    if (seconds < 86400) return `In ${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
    return `In ${Math.floor(seconds / 86400)} days`;
  }
  countdown(source = null) {
    const end = Date.parse(this.state(this._config.end));
    if (!Number.isFinite(end)) return 'End time unavailable';
    const seconds = Math.max(0, Math.ceil((end-Date.now()) / 1000));
    if (!seconds) return 'Finishing...';
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    const pad = n => String(n).padStart(2,'0');
    return `${source === 'manual_cycle' ? 'Station ends in' : 'Stopping in'} ${h ? `${h}:` : ''}${pad(m)}:${pad(s)}`;
  }
  value(id, digits = null) {
    const state = this.state(id);
    if (!this.valid(state)) return '—';
    const number = Number(state);
    const unit = this.entity(id)?.attributes?.unit_of_measurement || '';
    const formatted = digits !== null && Number.isFinite(number)
      ? number.toLocaleString('en-GB',{minimumFractionDigits:digits,maximumFractionDigits:digits})
      : state;
    return `${formatted}${unit ? ' ' + unit : ''}`;
  }
  chip(label, value, icon, id, extra = '') {
    return `<button class="chip ${extra}" data-info="${this.escape(id)}">
      <span class="chip-icon"><ha-icon icon="${icon}"></ha-icon></span>
      <span class="chip-copy"><span class="muted">${this.escape(label)}</span><strong>${this.escape(value)}</strong></span>
    </button>`;
  }
  row(label, value, id, icon = '') {
    return `<button class="detail-row" data-info="${this.escape(id)}">
      <span>${icon ? `<ha-icon icon="${icon}"></ha-icon>` : ''}${this.escape(label)}</span>
      <strong>${this.escape(value)}</strong>
      <ha-icon icon="mdi:chevron-right"></ha-icon>
    </button>`;
  }
  connectionLost() {
    const switches = this._config?.connection_switches || [];
    return switches.some(id => !this.valid(this.state(id)));
  }
  controllerData(c) {
    const controller = this.state(c.controller);
    const connectionLost = (c.connection_switches || []).some(id => !this.valid(this.state(id)));
    const active = (c.zone_statuses || []).some(id => String(this.state(id)).toLowerCase() === 'sprinkling');
    const source = active ? this.irrigationSource(c) : null;
    const available = this.valid(controller) && !connectionLost;
    const station = this.state(c.station);
    const nextTime = Date.parse(this.state(c.next));
    const lastTime = Date.parse(this.state(c.last));
    return { ...c, controller, controllerEntity: c.controller, connectionLost, active, available, station, source,
      nextTime: Number.isFinite(nextTime) && nextTime >= Date.now() ? nextTime : null,
      lastTime: Number.isFinite(lastTime) && lastTime <= Date.now() ? lastTime : null };
  }
  renderMultiOverview() {
    const controllers = this._config.controllers.map(c => this.controllerData(c));
    const available = controllers.filter(c => c.available);
    const on = available.filter(c => c.controller.toLowerCase() === 'on').length;
    const off = available.filter(c => c.controller.toLowerCase() === 'off').length;
    const missing = controllers.length - available.length;
    const active = controllers.filter(c => c.active);
    const next = controllers.filter(c => c.nextTime !== null).sort((a,b) => a.nextTime-b.nextTime)[0];
    const last = controllers.filter(c => c.lastTime !== null).sort((a,b) => b.lastTime-a.lastTime)[0];
    const stateText = [on ? `${on} On` : '',off ? `${off} Off` : '',missing ? `${missing} Unavailable` : ''].filter(Boolean).join(' · ');
    const headline = active.length === 1 ? this.irrigationHeadline(active[0].source) : active.length ? 'Irrigation running' : on ? 'Irrigation ready' : missing === controllers.length ? 'Connection lost' : 'Irrigation unavailable';
    const stationText = active.length ? active.map(c => `${c.name}: ${c.station}${this.irrigationLabel(c.source) ? ` · ${this.irrigationLabel(c.source)}` : ''}`).join(' · ') : 'No active irrigation';
    const tile = (label, c, id, fmt) => this.chip(label, c ? `${fmt(id)} · ${c.name}` : '—', 'mdi:calendar-clock', c?.[id] || '');
    const summary = `<div class="hero ${active.length ? 'active' : missing ? 'error' : on ? 'ready' : 'off'}">
      <span class="hero-icon"><ha-icon icon="mdi:sprout"></ha-icon></span>
      <div class="hero-copy"><strong>${this.escape(headline)}</strong><small>${this.escape(stationText)}</small></div><span class="status-dot"></span>
    </div>
    <div class="overview-grid">
      ${this.chip('Next irrigation',next ? `${this.timeUntil(next.next)} · ${next.name}` : '—','mdi:calendar-clock',next?.next)}
      ${this.chip('Last irrigation',last ? `${this.timeSince(last.last)} · ${last.name}` : '—','mdi:history',last?.last)}
    </div>`;
    const sections = controllers.map((c,index) => {
      const mode = c.connectionLost || !c.available ? 'error' : c.active ? 'active' : c.controller.toLowerCase() === 'on' ? 'ready' : 'off';
      const expanded = !this._expandedControllers.has(index);
      return `<section class="controller-section">
        <button class="controller-heading" data-controller-toggle="${index}" aria-expanded="${expanded}"><strong>${this.escape(c.name || `Controller ${index+1}`)}</strong><span class="controller-state ${mode}">${this.escape(c.available ? c.controller : 'Unavailable')}</span><ha-icon class="chevron" icon="mdi:chevron-${expanded ? 'up' : 'down'}"></ha-icon></button>
        ${expanded ? `<div class="overview-grid">
          ${this.chip('Next irrigation',this.timeUntil(c.next),'mdi:calendar-clock',c.next)}
          ${this.chip('Last irrigation',this.timeSince(c.last),'mdi:history',c.last)}
          ${this.chip('Current station',c.active ? c.station : 'Idle','mdi:sprinkler',c.station)}
          ${this.chip('Controller',c.controller,'mdi:water-pump',c.controller)}
        </div>` : ''}
        ${c.active && this.irrigationLabel(c.source) ? `<small class="controller-source">${this.escape(this.irrigationLabel(c.source))}</small>` : ''}
        ${c.active ? `<small class="controller-countdown" data-live-controller="${index}">${this.escape(this.countdownFor(c.end, c.source))}</small>` : ''}
        ${expanded ? this.cycleAction({...c, controller: c.controllerEntity}, c.active, c.source) : ''}
      </section>`;
    }).join('');
    return summary + sections;
  }
  countdownFor(id, source = null) {
    const end = Date.parse(this.state(id));
    if (!Number.isFinite(end)) return 'End time unavailable';
    const seconds = Math.max(0,Math.ceil((end-Date.now())/1000));
    if (!seconds) return 'Finishing...';
    const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
    const pad=n=>String(n).padStart(2,'0');
    return `${source === 'manual_cycle' ? 'Station ends in' : 'Stopping in'} ${h ? `${h}:` : ''}${pad(m)}:${pad(s)}`;
  }
  renderOverview() {
    if (this._config.controllers) return this.renderMultiOverview();
    const c = this._config;
    const controller = this.state(c.controller);
    const active = c.zone_statuses.some(id => this.state(id).toLowerCase() === 'sprinkling');
    const source = active ? this.irrigationSource(c) : null;
    const lost = this.connectionLost();
    const mode = lost ? 'error' : active ? 'active' : controller.toLowerCase() === 'on' ? 'ready' : 'off';
    const status = lost ? 'Connection lost' : active ? this.irrigationHeadline(source) : mode === 'ready' ? 'Irrigation ready' : `Controller ${controller}`;
    const subtitle = lost ? 'Check the RainBird controller' : active ? this.state(c.station) : mode === 'ready' ? 'No active irrigation' : 'Irrigation unavailable';
    return `<div class="hero ${mode}">
      <span class="hero-icon"><ha-icon icon="${active ? 'mdi:water' : lost ? 'mdi:wifi-alert' : 'mdi:sprout'}"></ha-icon></span>
      <div class="hero-copy"><strong>${this.escape(status)}</strong><small>${this.escape(subtitle)}</small>${active ? `<small class="countdown" data-live="countdown">${this.escape(this.countdown(source))}</small>` : ''}</div>
      <span class="status-dot"></span>
    </div>
    <div class="overview-grid">
      ${this.chip('Next irrigation',this.timeUntil(c.next),'mdi:calendar-clock',c.next)}
      ${this.chip('Last irrigation',this.timeSince(c.last),'mdi:history',c.last)}
      ${this.chip('Controller',controller,'mdi:water-pump',c.controller)}
      ${this.chip('Current station',this.state(c.station),'mdi:sprinkler',c.station)}
    </div>${this.cycleAction(c, active, source)}`;
  }
  renderWeather() {
    const c = this._config;
    const isRaining = this.state(c.raining) === 'on';
    const forecast = this.state(c.rain_forecast) === 'on';
    const headline = isRaining ? 'Raining now' : forecast ? 'Rain expected' : 'Dry conditions';
    return `<div class="weather-header">
      <span class="weather-heading"><ha-icon icon="${isRaining ? 'mdi:weather-rainy' : 'mdi:weather-partly-cloudy'}"></ha-icon><strong>Weather & Rain</strong></span>
      <span class="weather-condition">${this.escape(headline)}</span>
    </div>
    <div class="weather-grid">
      ${this.chip('Rain today',this.value(c.rain_today,2),'mdi:weather-pouring',c.rain_today)}
      ${this.chip('Forecast today',this.value(c.forecast_today,2),'mdi:weather-cloudy',c.forecast_today)}
      ${this.chip('Rain duration',this.valid(this.state(c.rain_duration)) ? `${Math.round(Number(this.state(c.rain_duration)) || 0)} min` : '—','mdi:timer-outline',c.rain_duration)}
    </div>
    <div class="weather-bottom">${this.row('Last rain',this.timeSince(c.last_rain),c.last_rain,'mdi:history')}${Array.isArray(c.water_sensors) && c.water_sensors.length ? c.water_sensors.map(item => this.row(`Total irrigation water (${item.name || 'Controller'})`,this.value(item.entity,2),item.entity,'mdi:water')).join('') : this.row('Total irrigation water',this.value(c.water,2),c.water,'mdi:water')}</div>
    <button class="details-toggle" data-toggle aria-expanded="${this._expanded}">
      <span>${this._expanded ? 'Hide weather details' : 'More weather details'}</span><ha-icon icon="mdi:chevron-${this._expanded ? 'up' : 'down'}"></ha-icon>
    </button>
    ${this._expanded ? `<div class="weather-details">
      ${this.row('Raining now',isRaining ? 'Yes' : 'No',c.raining,'mdi:weather-rainy')}
      ${this.row('Will it rain today?',forecast ? 'Yes' : 'No',c.rain_forecast,'mdi:weather-cloudy')}
    </div>` : ''}`;
  }
  updateLiveText() {
    if (!this._config || !this._hass) return;
    const el = this.shadowRoot.querySelector('[data-live="countdown"]');
    if (el) el.textContent = this.countdown(this.irrigationSource(this._config));
    this.shadowRoot.querySelectorAll('[data-live-controller]').forEach(node => {
      const c = this._config.controllers?.[Number(node.dataset.liveController)];
      if (c) node.textContent = this.countdownFor(c.end, this.irrigationSource(c));
    });
  }
  render() {
    if (!this._config || !this._hass) return;
    const html = this._config.mode === 'overview' ? this.renderOverview() : this.renderWeather();
    this.shadowRoot.innerHTML = `<style>
      :host {display:block;color:var(--primary-text-color);--accent-green:var(--success-color,#43a047);--accent-blue:var(--info-color,#039be5);--accent-red:var(--error-color,#db4437)}
      ha-card {border-radius:18px;overflow:hidden;padding:14px;background:var(--ha-card-background,var(--card-background-color))}
      button {border:0;color:inherit;font:inherit;cursor:pointer;background:transparent;text-align:left}
      .hero {display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;background:color-mix(in srgb,var(--accent-green) 9%,transparent)}
      .hero.active {background:color-mix(in srgb,var(--accent-blue) 10%,transparent)}
      .hero.error {background:color-mix(in srgb,var(--accent-red) 10%,transparent)}
      .hero.off {background:var(--secondary-background-color,rgba(128,128,128,.1))}
      .hero-icon {height:44px;width:44px;flex:none;display:grid;place-items:center;border-radius:13px;background:color-mix(in srgb,var(--accent-green) 16%,transparent);color:var(--accent-green)}
      .active .hero-icon {color:var(--accent-blue);background:color-mix(in srgb,var(--accent-blue) 16%,transparent)}
      .error .hero-icon {color:var(--accent-red);background:color-mix(in srgb,var(--accent-red) 16%,transparent)}
      .hero-icon ha-icon {--mdc-icon-size:25px}
      .hero-copy {display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.hero-copy strong{font-size:16px}.hero-copy small{font-size:12px;color:var(--secondary-text-color)}
      .hero-copy .countdown{color:var(--accent-blue);font-weight:700;font-variant-numeric:tabular-nums}
      .status-dot {width:9px;height:9px;border-radius:50%;background:var(--accent-green);flex:none}.active .status-dot{background:var(--accent-blue)}.error .status-dot{background:var(--accent-red)}.off .status-dot{background:var(--secondary-text-color)}
      .controller-section{border:1px solid var(--divider-color,rgba(128,128,128,.2));border-radius:13px;padding:12px;margin-top:12px}
      .controller-heading{display:flex;align-items:center;width:100%;justify-content:space-between;gap:8px;padding:0;text-align:left}.controller-heading strong{flex:1}.controller-heading .chevron{--mdc-icon-size:21px;color:var(--secondary-text-color);flex:none}
      .controller-state{font-size:12px;font-weight:650;color:var(--accent-green)}.controller-state.off{color:var(--secondary-text-color)}.controller-state.error{color:var(--accent-red)}.controller-state.active{color:var(--accent-blue)}
      .controller-source{display:block;margin-top:9px;color:var(--secondary-text-color);font-size:12px}
      .controller-countdown{display:block;margin-top:5px;color:var(--accent-blue);font-weight:650;font-variant-numeric:tabular-nums}
      .cycle-action{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:11px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--accent-green) 9%,transparent)}
      .cycle-action.cycle-stop{background:color-mix(in srgb,var(--accent-red) 8%,transparent)}
      .cycle-action.neutral{background:var(--secondary-background-color,rgba(128,128,128,.08))}
      .cycle-copy{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
      .cycle-copy strong{font-size:13px;font-weight:700}
      .cycle-copy small{font-size:11px;color:var(--secondary-text-color);line-height:1.3}
      .cycle-button{display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;border-radius:10px;padding:10px 12px;background:color-mix(in srgb,var(--accent-green) 17%,transparent);color:var(--accent-green);font-size:12px;font-weight:700;flex:none}
      .cycle-stop .cycle-button{background:color-mix(in srgb,var(--accent-red) 18%,transparent);color:var(--accent-red)}
      .cycle-button ha-icon{--mdc-icon-size:17px}
      .cycle-button:disabled{opacity:.4;cursor:not-allowed}
      .overview-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:10px}
      .chip{display:flex;align-items:center;gap:9px;padding:11px 9px;border-radius:12px;background:var(--secondary-background-color,rgba(128,128,128,.09));min-width:0;min-height:65px}
      .chip-icon {height:35px;width:35px;flex:none;display:grid;place-items:center;border-radius:10px;background:color-mix(in srgb,var(--accent-blue) 10%,transparent);color:var(--accent-blue)}
      .chip-icon ha-icon{--mdc-icon-size:21px}.chip-copy{display:flex;flex-direction:column;gap:5px;min-width:0}.muted{font-size:11px;color:var(--secondary-text-color)}
      .chip-copy strong{font-size:13px;font-weight:650;overflow-wrap:anywhere;line-height:1.25}
      .weather-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.weather-heading{display:flex;align-items:center;gap:9px;font-size:15px}.weather-heading ha-icon{color:var(--accent-blue)}
      .weather-condition{font-size:11px;color:var(--secondary-text-color);white-space:nowrap}
      .weather-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
      .weather-grid .chip{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px 7px;min-height:79px}
      .weather-grid .chip-icon{height:25px;width:25px;border-radius:7px}.weather-grid .chip-icon ha-icon{--mdc-icon-size:17px}
      .weather-grid .chip-copy strong{font-size:13px}
      .weather-bottom{margin-top:10px}
      .detail-row{width:100%;display:flex;align-items:center;gap:8px;min-height:40px;border-bottom:1px solid var(--divider-color,rgba(128,128,128,.13));padding:6px 3px;font-size:12px}
      .detail-row span{display:flex;align-items:center;gap:7px;flex:1;color:var(--secondary-text-color);min-width:0}.detail-row span ha-icon{--mdc-icon-size:17px;color:var(--accent-blue)}
      .detail-row strong{font-size:12px;font-weight:650;text-align:right;overflow-wrap:anywhere}.detail-row>ha-icon{--mdc-icon-size:15px;color:var(--secondary-text-color)}
      .details-toggle{display:flex;justify-content:space-between;align-items:center;width:100%;padding:11px 3px 1px;font-size:12px;color:var(--accent-blue);font-weight:650}
      .details-toggle ha-icon{--mdc-icon-size:19px}
      .weather-details{padding-top:8px}
      @media(max-width:360px){ha-card{padding:10px}.chip{padding:9px 6px;gap:5px}.chip-icon{width:29px;height:29px}.weather-grid .chip{padding:8px 5px}.chip-copy strong{font-size:12px}}
    </style><ha-card>${html}</ha-card>`;
    this.shadowRoot.querySelectorAll('[data-info]').forEach(button => {
      button.addEventListener('click', () => this.moreInfo(button.dataset.info));
    });
    this.shadowRoot.querySelectorAll('[data-controller-toggle]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.controllerToggle);
      if (this._expandedControllers.has(index)) this._expandedControllers.delete(index);
      else this._expandedControllers.add(index);
      this.render();
    }));
    this.shadowRoot.querySelectorAll('[data-cycle-action]').forEach(button => button.addEventListener('click', () => {
      void this.executeCycleAction(button.dataset.cycleController, button.dataset.cycleAction);
    }));
    this.shadowRoot.querySelector('[data-toggle]')?.addEventListener('click', () => {
      this._expanded = !this._expanded;
      this.render();
    });
    this.updateLiveText();
  }
}
if (!customElements.get('irrigation-summary-card')) {
  customElements.define('irrigation-summary-card', IrrigationSummaryCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === 'irrigation-summary-card')) {
  window.customCards.push({type:'irrigation-summary-card',name:'RainBird Irrigation Summary',description:'Overview and expandable weather details'});
}