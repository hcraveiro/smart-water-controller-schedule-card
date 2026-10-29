/* RainBird expandable irrigation card, v6. Interface and comments in English. */
class IrrigationZonesCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.openZone = -1;
    this.busy = false;
    this.timer = null;
    this.draftDuration = null;
    this.draftDurations = {};
  }
  setConfig(config) {
    if (!Array.isArray(config.zones) || !config.zones.length) throw Error('zones is required');
    this.config = {
      duration: 'number.rainbird_irrigation_manual_duration',
      end_time: 'sensor.rainbird_irrigation_end_time',
      stop: 'button.rainbird_stop_sprinkle',
      show_global_stop: true,
      duration_step: 1,
      connection_switches: [
        'switch.rain_bird_sprinkler_1',
        'switch.rain_bird_sprinkler_2',
        'switch.rain_bird_sprinkler_3'
      ],
      ...config
    };
    this.openZone = -1;
    this.render();
  }
  set hass(value) {
    this._hass = value;
    const ids = [
      this.config?.duration, this.config?.end_time, this.config?.stop,
      ...(this.config?.connection_switches || []),
      ...(this.config?.zones || []).flatMap(zone => [
        zone.status, zone.today, zone.planned, zone.remaining, zone.valve,
        zone.duration, zone.end_time, zone.stop,
        ...(zone.connection_switches || [])
      ])
    ].filter(Boolean);
    const current = ids.map(id => value?.states?.[id]);
    if (this._trackedIds?.length === ids.length &&
        ids.every((id, index) =>
          id === this._trackedIds[index] &&
          current[index] === this._trackedEntities[index])) {
      this.updateCountdown();
      return;
    }
    this._trackedIds = ids;
    this._trackedEntities = current;
    this.render();
  }
  connectedCallback() {
    if (!this.timer) this.timer = setInterval(() => this.updateCountdown(), 1000);
  }
  disconnectedCallback() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  getCardSize() { return Math.max(2, this.config?.zones?.length || 3); }
  esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  entity(id) { return id ? this._hass?.states?.[id] : null; }
  state(id) { return this.entity(id)?.state ?? 'unavailable'; }
  irrigationSource(zone) {
    const source = this.entity(zone?.status)?.attributes?.irrigation_source;
    return typeof source === 'string' && source.trim() ? source.trim().toLowerCase() : null;
  }
  irrigationLabel(zone) {
    return {
      automatic: 'Scheduled watering',
      manual: 'Manual watering',
      manual_cycle: 'Manual cycle',
      external: 'External watering'
    }[this.irrigationSource(zone)] || null;
  }
  valid(value) { return !['unknown','unavailable','none',''].includes(String(value ?? '').toLowerCase()); }
  running(zone) { return String(this.state(zone.status)).toLowerCase() === 'sprinkling'; }
  active() { return this.config?.zones?.find(zone => this.running(zone)); }
  zoneGroup(zone) { return zone?.controller || '__default'; }
  groupZones(zone) { return (this.config?.zones || []).filter(item => this.zoneGroup(item) === this.zoneGroup(zone)); }
  connectionLost(zone = null) {
    const switches = zone?.connection_switches ?? this.config?.connection_switches ?? [];
    return switches.some(id => !this.valid(this.state(id)));
  }
  durationId(zone = null) { return zone?.duration || this.config.duration; }
  stopId(zone = null) { return zone?.stop || this.config.stop; }
  endTimeId(zone = null) { return zone?.end_time || this.config.end_time; }
  duration(zone = null) {
    const id = this.durationId(zone);
    const real = Number(this.state(id));
    const draft = this.draftDurations[id];
    if (draft !== undefined && Number.isFinite(real) && real === draft) delete this.draftDurations[id];
    return this.draftDurations[id] ?? (this.valid(this.state(id)) && Number.isFinite(real) ? real : null);
  }
  durationLimits(zone = null) {
    const attr = this.entity(this.durationId(zone))?.attributes || {};
    return {
      min: Number.isFinite(Number(attr.min)) ? Number(attr.min) : 1,
      max: Number.isFinite(Number(attr.max)) ? Number(attr.max) : 120,
      step: Number(this.config.duration_step) > 0 ? Number(this.config.duration_step) : 1
    };
  }
  countdown(zone = null) {
    const raw = this.state(this.endTimeId(zone));
    if (!this.valid(raw)) return 'End time unavailable';
    const end = Date.parse(raw);
    if (!Number.isFinite(end)) return 'End time unavailable';
    let seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    if (!seconds) return 'Finishing...';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = seconds % 60;
    const pad = n => String(n).padStart(2, '0');
    const label = this.irrigationSource(zone) === 'manual_cycle' ? 'Station ends in ' : 'Stopping in ';
    return label + (h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`);
  }
  updateCountdown() {
    this.shadowRoot.querySelectorAll('[data-countdown]').forEach(el => {
      const zone = this.config?.zones?.[Number(el.dataset.countdown)];
      if (zone && this.running(zone)) el.textContent = this.countdown(zone);
    });
  }
  info(id) {
    if (!id) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles:true, composed:true, detail:{entityId:id} }));
  }
  value(id) {
    const value = this.state(id);
    if (!this.valid(value)) return '—';
    const unit = this.entity(id)?.attributes?.unit_of_measurement || '';
    return this.esc(value) + (unit ? ' ' + this.esc(unit) : '');
  }
  metric(label, id) {
    return id ? `<button class="metric" data-info="${this.esc(id)}"><span>${this.esc(label)}</span><strong>${this.value(id)}</strong></button>` : '';
  }
  progress(zone) {
    const done = this.state(zone.today), total = this.state(zone.planned);
    if (!this.valid(done) || !this.valid(total)) return null;
    const a = Number(done), b = Number(total);
    return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? Math.min(100,Math.max(0,a / b * 100)) : null;
  }
  async changeDuration(direction, zone = null) {
    const id = this.durationId(zone);
    if (this.busy || this.connectionLost(zone) || !this.entity(id)) return;
    const current = this.duration(zone);
    if (current === null) return;
    const {min,max,step} = this.durationLimits(zone);
    const next = Math.max(min, Math.min(max, Number((current + direction * step).toFixed(3))));
    if (next === current) return;
    this.busy = true; this.draftDurations[id] = next; this.render();
    try {
      await this._hass.callService('number','set_value',{entity_id:id,value:next});
    } catch (error) {
      delete this.draftDurations[id];
      console.error('Failed to set duration:', error);
      alert('Unable to update irrigation duration.');
    } finally { this.busy = false; this.render(); }
  }
  async press(id, message, zone = null) {
    if (!id || this.busy || this.connectionLost(zone) || !confirm(message)) return;
    if (this.connectionLost(zone)) return;
    this.busy = true; this.render();
    try {
      await this._hass.callService('button','press',{entity_id:id});
    } catch (error) {
      console.error('Irrigation command failed:',error);
      alert('Unable to execute irrigation command.');
    } finally { this.busy = false; this.render(); }
  }
  start(zone) {
    if (this.connectionLost(zone)) return;
    if (this.groupZones(zone).some(other => this.running(other))) { alert('Another irrigation zone on this controller is already running. Stop it first.'); return; }
    const minutes = this.duration(zone);
    if (minutes === null) { alert('Irrigation duration is unavailable.'); return; }
    this.press(zone.start, `Start ${zone.name} for ${minutes} minutes?`, zone);
  }
  stop(name, zone = null) {
    this.press(this.stopId(zone), name ? `Stop irrigation for ${name}?` : 'Stop all irrigation?', zone);
  }
  render() {
    if (!this.config || !this._hass) return;
    const active = this.active();
    const disconnected = this.connectionLost();
    const multiController = new Set(this.config.zones.map(zone => this.zoneGroup(zone))).size > 1;
    const rows = this.config.zones.map((zone,index) => {
      const running = this.running(zone), expanded = this.openZone === index, progress = this.progress(zone);
      const sourceLabel = running ? this.irrigationLabel(zone) : null;
      const duration = this.duration(zone), {min,max} = this.durationLimits(zone);
      const disconnected = this.connectionLost(zone);
      const activeInGroup = this.groupZones(zone).some(other => this.running(other));
      return `<section class="zone ${running ? 'running' : ''}">
        <button class="summary" data-toggle="${index}" aria-expanded="${expanded}">
          <span class="symbol"><ha-icon icon="${running ? 'mdi:water' : 'mdi:sprinkler-variant'}"></ha-icon></span>
          <span class="title"><strong>${this.esc(zone.name)}</strong><small class="${running ? 'active' : ''}">${this.esc(this.state(zone.status))}</small>${sourceLabel ? `<small class="irrigation-source">${this.esc(sourceLabel)}</small>` : ''}${running ? `<small class="countdown" data-countdown="${index}">${this.esc(this.countdown(zone))}</small>` : ''}</span>
          <span class="today"><strong>${this.value(zone.today)}</strong><small>Today</small></span>
          <ha-icon class="chevron" icon="mdi:chevron-${expanded ? 'up':'down'}"></ha-icon>
        </button>
        ${expanded ? `<div class="details">
          <div class="metrics">${this.metric('Status',zone.status)}${this.metric('Irrigated today',zone.today)}${this.metric('Scheduled today',zone.planned)}${this.metric('Remaining today',zone.remaining)}</div>
          ${progress === null ? '' : `<div class="progress-label"><span>Today's schedule</span><strong>${Math.round(progress)}%</strong></div><div class="progress"><div style="width:${progress}%"></div></div>`}
          <div class="controls"><div class="duration"><label>Manual duration</label><div class="stepper">
            <button data-step="-1" data-zone="${index}" ${this.busy || disconnected || duration === null || duration <= min ? 'disabled':''}><ha-icon icon="mdi:minus"></ha-icon></button>
            <button data-info="${this.esc(this.durationId(zone))}" class="duration-value">${duration ?? '—'} min</button>
            <button data-step="1" data-zone="${index}" ${this.busy || disconnected || duration === null || duration >= max ? 'disabled':''}><ha-icon icon="mdi:plus"></ha-icon></button>
          </div></div><button class="action ${running ? 'stop':'start'}" data-action="${index}" ${this.busy || disconnected || (!running && activeInGroup) ? 'disabled':''}><ha-icon icon="mdi:${running ? 'stop':'play'}"></ha-icon>${running ? 'Stop':'Start'}</button></div>
          ${zone.valve ? `<button class="valve" data-info="${this.esc(zone.valve)}"><ha-icon icon="mdi:valve"></ha-icon>Valve details<ha-icon icon="mdi:chevron-right"></ha-icon></button>` : ''}
        </div>` : ''}</section>`;
    }).join('');
    const globalStop = !multiController && this.config.show_global_stop && active
      ? `<div class="global"><span><ha-icon icon="mdi:water"></ha-icon> Irrigating: ${this.esc(active.name)}${this.irrigationLabel(active) ? ` · ${this.esc(this.irrigationLabel(active))}` : ''}</span><button data-stop-all ${this.busy || disconnected?'disabled':''}><ha-icon icon="mdi:stop-circle-outline"></ha-icon>Stop All</button></div>` : '';
    const connectionWarning = !multiController && disconnected
      ? `<div class="connection-warning"><ha-icon icon="mdi:wifi-off"></ha-icon><span>Controller unavailable — irrigation controls disabled</span></div>`
      : '';
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;color:var(--primary-text-color);--green:var(--success-color,#43a047);--red:var(--error-color,#db4437);--blue:var(--info-color,#039be5);--border:var(--divider-color,rgba(128,128,128,.2))}
      ha-card{overflow:hidden;border-radius:18px;padding:5px 13px;background:var(--ha-card-background,var(--card-background-color))}
      button{font:inherit;color:inherit;cursor:pointer;border:0}button:disabled{opacity:.4;cursor:not-allowed}
      .connection-warning{display:flex;align-items:center;gap:8px;padding:11px 8px;color:var(--red);font-size:12px;font-weight:600;background:color-mix(in srgb,var(--red) 9%,transparent);border-radius:10px;margin:7px 0}.connection-warning ha-icon{--mdc-icon-size:19px}
      .zone+.zone{border-top:1px solid var(--border)}.summary{display:flex;align-items:center;width:100%;min-height:73px;padding:10px 3px;background:transparent;text-align:left;gap:12px}
      .symbol{display:flex;align-items:center;justify-content:center;width:43px;height:43px;flex:none;border-radius:13px;background:color-mix(in srgb,var(--green) 13%,transparent);color:var(--green)}
      .running .symbol{background:color-mix(in srgb,var(--blue) 16%,transparent);color:var(--blue)}.symbol ha-icon{--mdc-icon-size:24px}
      .title{display:flex;flex-direction:column;flex:1;gap:5px;min-width:0}.title strong{font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      small{font-size:12px;color:var(--secondary-text-color)}.title .active,.countdown{color:var(--blue);font-weight:650}.title .irrigation-source{font-size:11px;color:var(--secondary-text-color)}.countdown{font-size:11px;font-variant-numeric:tabular-nums}
      .today{display:flex;flex-direction:column;text-align:right;gap:3px;min-width:49px}.today strong{font-size:15px;font-variant-numeric:tabular-nums}.chevron{color:var(--secondary-text-color);--mdc-icon-size:21px}
      .details{padding:1px 1px 15px 55px}.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .metric{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;padding:10px;border-radius:10px;background:var(--secondary-background-color,rgba(128,128,128,.09));text-align:left}
      .metric span{font-size:11px;color:var(--secondary-text-color)}.metric strong{font-size:15px;font-variant-numeric:tabular-nums}
      .progress-label{display:flex;justify-content:space-between;margin:13px 0 5px;font-size:11px;color:var(--secondary-text-color)}.progress{height:6px;border-radius:20px;background:var(--divider-color,#ddd);overflow:hidden}.progress>div{height:100%;background:var(--green);border-radius:20px}
      .controls{display:flex;align-items:flex-end;gap:10px;margin-top:15px}.duration{display:flex;flex-direction:column;gap:7px;flex:1;min-width:0}.duration label{font-size:11px;color:var(--secondary-text-color)}
      .stepper{display:flex;align-items:center;justify-content:space-between;gap:4px;border-radius:10px;background:var(--secondary-background-color,rgba(128,128,128,.1));padding:3px}
      .stepper button{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:var(--ha-card-background,var(--card-background-color))}.stepper button ha-icon{--mdc-icon-size:18px}
      .stepper .duration-value{width:auto;padding:0 3px;background:transparent;font-size:13px;font-weight:650;white-space:nowrap;font-variant-numeric:tabular-nums}
      .action{display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 17px;border-radius:10px;font-size:13px;font-weight:650;min-width:88px}.action ha-icon{--mdc-icon-size:18px}
      .start{background:color-mix(in srgb,var(--green) 17%,transparent);color:var(--green)}.stop{background:color-mix(in srgb,var(--red) 20%,transparent);color:var(--red)}
      .valve{display:flex;align-items:center;gap:6px;margin-top:12px;padding:5px 0;background:transparent;color:var(--secondary-text-color);font-size:12px}.valve ha-icon{--mdc-icon-size:17px}
      .global{display:flex;align-items:center;gap:10px;padding:12px 3px;border-top:1px solid var(--border)}.global span{display:flex;align-items:center;gap:7px;flex:1;min-width:0;font-size:12px;color:var(--secondary-text-color)}
      .global span ha-icon{color:var(--blue);--mdc-icon-size:19px}.global button{display:flex;align-items:center;gap:6px;padding:10px 14px;border-radius:10px;background:color-mix(in srgb,var(--red) 16%,transparent);color:var(--red);font-size:12px;font-weight:700}.global button ha-icon{--mdc-icon-size:18px}
      @media(max-width:370px){.summary{gap:8px}.details{padding-left:0}.symbol{width:37px;height:37px}.controls{gap:7px}.action{min-width:72px;padding:12px 10px}}
    </style><ha-card>${connectionWarning}${rows}${globalStop}</ha-card>`;
    this.shadowRoot.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => {
      const index = Number(el.dataset.toggle);
      this.openZone = this.openZone === index ? -1 : index;
      this.render();
    }));
    this.shadowRoot.querySelectorAll('[data-info]').forEach(el => el.addEventListener('click', () => this.info(el.dataset.info)));
    this.shadowRoot.querySelectorAll('[data-step]').forEach(el => el.addEventListener('click', () => this.changeDuration(Number(el.dataset.step), this.config.zones[Number(el.dataset.zone)])));
    this.shadowRoot.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => {
      const zone = this.config.zones[Number(el.dataset.action)];
      if (this.running(zone)) this.stop(zone.name, zone); else this.start(zone);
    }));
    this.shadowRoot.querySelector('[data-stop-all]')?.addEventListener('click', () => this.stop());
    this.updateCountdown();
  }
}
if (!customElements.get('irrigation-zones-card')) {
  customElements.define('irrigation-zones-card', IrrigationZonesCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === 'irrigation-zones-card')) {
  window.customCards.push({type:'irrigation-zones-card',name:'Irrigation Zones',description:'Expandable RainBird irrigation controls'});
}