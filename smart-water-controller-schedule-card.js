// Printed to the browser console on load. It exists because "the card is not
// updated" and "the browser is running a different file" look identical on
// screen, and a stale pre-compressed copy next to the bundle can make the
// server serve the old one. Bump it when you release.
const CARD_VERSION = "2.0.1";

const MONTH_COUNT = 12;

// The controller protocol carries a sprinkle duration in seconds over two bytes,
// so anything above 65535 seconds cannot be sent to the device at all.
const MAX_STATION_MINUTES = Math.floor(65535 / 60);
const MAX_INTERVAL_DAYS = 31;

const DEFAULT_TIME = "07:00:00";

function escapeText(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
    return escapeText(value)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function toMidnight(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(from, to) {
    return Math.round((to.getTime() - from.getTime()) / 86400000);
}

// Which days of a month water, and how much of that is a fact.
//
// `interval_days` is not a grid on the calendar. The integration anchors it on
// `max(last_rain, last_sprinkle)` and blocks the day when fewer than
// `interval_days` have passed since, so rain resets the countdown: "every 2
// days" in June means "two days after the ground last got wet", not "even
// days". That makes every future day a projection *at unchanged weather*, and
// this function is where that distinction is kept honest:
//
//   - days before today are never marked. With only the latest anchor and no
//     history, an old `last_sprinkle` would otherwise paint four weeks of
//     waterings that never happened;
//   - today comes from the integration's own verdict (`blockedToday`) when it
//     is available, instead of being re-derived here, so the card cannot
//     disagree with the scheduler about the one day that is already decided;
//   - the rest is chained forward, each projected day becoming the next anchor.
//     `get_next_watering_date()` in the integration stops at the first day,
//     which is all a "next run" sensor needs and not enough to fill a month.
//
// `mode` says which of the two readings the caller is showing: "projected" when
// anchored on real data for the month we are actually in, "pattern" when it is
// just the shape of the rule applied from the 1st - any other month, where
// anchoring would be arithmetic dressed up as a forecast.
function projectWateringDays({
    year,
    monthIndex,
    hours,
    intervalDays,
    anchor = null,
    today = new Date(),
    blockedToday = null,
}) {
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const step = Math.max(1, Number(intervalDays) || 0);
    const waterHours = Array.isArray(hours) ? hours.filter(Boolean) : [];
    const midnightToday = toMidnight(today);
    const anchorDay = toMidnight(anchor);

    const isThisMonth =
        midnightToday.getFullYear() === year && midnightToday.getMonth() === monthIndex;
    const mode = isThisMonth && anchorDay ? "projected" : "pattern";

    const days = Array.from({ length: daysInMonth }, (_, index) => {
        const day = index + 1;
        const date = new Date(year, monthIndex, day);
        const delta = daysBetween(midnightToday, date);

        return {
            day,
            weekday: date.getDay(),
            isToday: isThisMonth && delta === 0,
            isPast: delta < 0,
            waters: false,
            blocked: false,
        };
    });

    if (!waterHours.length) {
        return { mode, days, hours: waterHours, intervalDays: step, daysInMonth };
    }

    // In "pattern" mode the 1st is the reference, so put the virtual previous
    // watering exactly one interval before it.
    let lastWet = mode === "projected"
        ? anchorDay
        : new Date(year, monthIndex, 1 - step);

    days.forEach((entry) => {
        const date = new Date(year, monthIndex, entry.day);

        // The past is not ours to claim. With only the latest anchor and no
        // history, marking days before today would invent waterings - and
        // worse, treating them as anchors would push the real projection out
        // of phase: a sprinkle on 24/09 and a 2-day interval would "water"
        // every other day of October and then conclude that today is too soon.
        if (entry.isPast && mode === "projected") {
            return;
        }

        // Today is already decided by the scheduler, and its verdict wins over
        // anything re-derived here - including the case the arithmetic gets
        // wrong on its own, where the ground got wet earlier *today* and the
        // remaining slots still run (schedule_state.py: "events from today do
        // not block today").
        if (entry.isToday && typeof blockedToday === "boolean") {
            entry.blocked = blockedToday;
            entry.waters = !blockedToday;

            if (entry.waters) {
                lastWet = date;
            }

            return;
        }

        if (daysBetween(lastWet, date) < step) {
            return;
        }

        entry.waters = true;
        lastWet = date;
    });

    return { mode, days, hours: waterHours, intervalDays: step, daysInMonth };
}

class IrrigationScheduleCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });

        this.currentMonth = new Date().getMonth();
        this.scheduleData = null;
        this._hass = null;
        this._config = null;
        this._servicePrefix = null;
        this._status = null;
        this._isDirty = false;
        this._lastLoadedScheduleJson = null;
        this._statusTimer = null;
        this._entitySignature = null;
        this._pendingEntitySync = false;
        this._externalChangePending = false;
        this._copyConfirm = null;

        this.shadowRoot.addEventListener("focusout", () => {
            window.setTimeout(() => {
                if (!this._hasActiveEditor() && this._pendingEntitySync && !this._isDirty) {
                    this._pendingEntitySync = false;
                    this._syncFromEntity(true);
                }
            }, 0);
        });
    }

    static getStubConfig(hass) {
        const candidate = Object.keys(hass?.states ?? {}).find((entityId) =>
            entityId.startsWith("sensor.") &&
            Array.isArray(hass.states[entityId]?.attributes?.schedule)
        );

        return { sensor: candidate ?? "sensor.controller_status" };
    }

    setConfig(config) {
        if (!config?.sensor) {
            throw new Error("You need to define a sensor in config.");
        }

        this._config = config;
        this.sensor = config.sensor;
        this._entitySignature = null;
        this._pendingEntitySync = false;

        if (this._hass) {
            this._syncFromEntity(true);
        } else {
            this.render();
        }
    }

    set hass(hass) {
        this._hass = hass;

        if (!this.sensor) {
            this.render();
            return;
        }

        const entity = this._getEntity();
        const nextSignature = this._buildEntitySignature(entity);

        if (nextSignature === this._entitySignature) {
            return;
        }

        this._entitySignature = nextSignature;

        if (this._hasActiveEditor() || this._isDirty) {
            this._pendingEntitySync = true;

            // Something changed the schedule outside the card while there are
            // local edits. Silently dropping the update used to leave the card
            // showing stale data with no way to notice, so say it out loud.
            if (this._isDirty) {
                this._externalChangePending = true;
                this._patchNotices();
            }

            return;
        }

        this._pendingEntitySync = false;
        this._syncFromEntity();
    }

    getCardSize() {
        const monthSchedule = this._getMonthSchedule();
        const rows = monthSchedule.hours.length + this._getStationCount();
        // Six week rows plus the weekday header and the legend, which is what
        // the grid actually occupies when it is shown.
        const calendar = this._config?.calendar === false ? 0 : 4;

        return (this._shouldShowHeader() ? 4 : 3) + calendar + Math.ceil(rows * 0.6);
    }

    _getEntity() {
        return this._hass?.states?.[this.sensor] ?? null;
    }

    _hasActiveEditor() {
        const activeElement = this.shadowRoot?.activeElement;
        return Boolean(activeElement?.matches?.("input, select, textarea"));
    }

    _shouldShowHeader() {
        return Boolean(this._config?.header);
    }

    _getHeaderTitle() {
        if (!this._shouldShowHeader()) {
            return "";
        }

        const configuredTitle = typeof this._config?.title === "string"
            ? this._config.title.trim()
            : "";

        if (configuredTitle) {
            return configuredTitle;
        }

        const entity = this._getEntity();
        const friendlyName = entity?.attributes?.friendly_name;

        if (friendlyName) {
            return String(friendlyName);
        }

        return "Irrigation schedule";
    }

    _buildEntitySignature(entity) {
        return JSON.stringify({
            friendly_name: entity?.attributes?.friendly_name ?? null,
            service_prefix: this._extractServicePrefix(entity),
            schedule: entity?.attributes?.schedule ?? null,
            station_names: entity?.attributes?.station_names ?? null,
            num_stations: entity?.attributes?.num_stations ?? null,
            header: Boolean(this._config?.header),
            title: this._getHeaderTitle(),
            // Rain moves the calendar without the schedule changing at all, so
            // the anchor belongs in the signature or the grid would keep
            // showing yesterday's projection.
            interval: this._getIntervalContext(),
        });
    }

    _extractServicePrefix(entity) {
        const attrs = entity?.attributes ?? {};

        if (attrs.service_prefix) {
            return String(attrs.service_prefix);
        }

        if (attrs.controller_service_prefix) {
            return String(attrs.controller_service_prefix);
        }

        const entityId = entity?.entity_id || this.sensor || "";
        const match = entityId.match(
            /^sensor\.([0-9a-fA-F]{2}(?:_[0-9a-fA-F]{2}){5})_/
        );

        return match ? match[1] : null;
    }

    _getStationCount() {
        const attrs = this._getEntity()?.attributes ?? {};

        const declared = Number(attrs.num_stations);
        if (Number.isInteger(declared) && declared > 0) {
            return declared;
        }

        if (Array.isArray(attrs.station_names) && attrs.station_names.length > 0) {
            return attrs.station_names.length;
        }

        // Last resort: the highest station index that appears anywhere in the
        // stored schedule. Deriving the rows from the current month alone meant
        // a month with no stations yet could never be configured from the card.
        let highest = 0;
        const months = Array.isArray(this.scheduleData) ? this.scheduleData : [];

        months.forEach((monthSchedule) => {
            Object.keys(monthSchedule?.stations ?? {}).forEach((stationKey) => {
                const match = String(stationKey).match(/^station_(\d+)_minutes$/);

                if (match) {
                    highest = Math.max(highest, Number(match[1]));
                }
            });
        });

        return highest;
    }

    _getStationLabel(stationId) {
        const attrs = this._getEntity()?.attributes ?? {};
        const stationNames = Array.isArray(attrs.station_names) ? attrs.station_names : [];
        const name = stationNames[stationId - 1];

        return name ? String(name) : `Station ${stationId}`;
    }

    _getNextScheduleEntity() {
        const states = this._hass?.states ?? {};

        if (this._config?.next_schedule) {
            return states[this._config.next_schedule] ?? null;
        }

        // Same device, sibling entity: derived rather than configured, because
        // one more required option is one more way to install the card wrong.
        const derived = String(this.sensor ?? "").replace(
            /_controller_status$/,
            "_next_schedule"
        );

        if (derived !== this.sensor && states[derived]) {
            return states[derived];
        }

        const found = Object.keys(states).find(
            (entityId) =>
                entityId.startsWith("sensor.") &&
                states[entityId]?.attributes?.has_watering_slots !== undefined
        );

        return found ? states[found] : null;
    }

    // The anchor the interval counts from, published by the integration on the
    // "next schedule" sensor. `last_rain` lives on the weather device, with a
    // different entity prefix, so it cannot be derived from the controller the
    // card was pointed at - which is exactly why it is republished there.
    _getIntervalContext() {
        const attrs = this._getNextScheduleEntity()?.attributes ?? {};

        const anchor = attrs.interval_anchor
            ? toMidnight(attrs.interval_anchor)
            : toMidnight(attrs.last_sprinkle) ?? toMidnight(attrs.last_rain);

        return {
            anchor,
            blockedToday:
                typeof attrs.blocked_today === "boolean" ? attrs.blocked_today : null,
            blockedUntil: attrs.blocked_until ?? null,
            lastRain: toMidnight(attrs.last_rain),
            lastSprinkle: toMidnight(attrs.last_sprinkle),
            available: Boolean(attrs.interval_anchor || attrs.last_sprinkle || attrs.last_rain),
        };
    }

    _syncFromEntity(force = false) {
        if (!this._hass || !this.sensor) {
            this.render();
            return;
        }

        const entity = this._getEntity();
        this._servicePrefix = this._extractServicePrefix(entity);

        const schedule = entity?.attributes?.schedule;
        const scheduleJson = schedule ? JSON.stringify(schedule) : null;

        if (
            scheduleJson &&
            (
                force ||
                !this.scheduleData ||
                (!this._isDirty && scheduleJson !== this._lastLoadedScheduleJson)
            )
        ) {
            this.scheduleData = JSON.parse(scheduleJson);
            this._lastLoadedScheduleJson = scheduleJson;
            this._externalChangePending = false;
        }

        if (!scheduleJson && force) {
            this.scheduleData = null;
            this._lastLoadedScheduleJson = null;
        }

        this.render();
    }

    _reloadFromEntity() {
        this._isDirty = false;
        this._pendingEntitySync = false;
        this._externalChangePending = false;
        this._copyConfirm = null;
        this._syncFromEntity(true);
        this._setStatus("Reloaded the schedule from Home Assistant.");
    }

    _getMonthSchedule(monthIndex = this.currentMonth) {
        if (!Array.isArray(this.scheduleData)) {
            return {
                hours: [],
                stations: {},
                interval_days: 0,
            };
        }

        const schedule = this.scheduleData[monthIndex] || {};

        return {
            hours: Array.isArray(schedule.hours) ? [...schedule.hours] : [],
            stations:
                schedule.stations && typeof schedule.stations === "object"
                    ? { ...schedule.stations }
                    : {},
            interval_days: Number.isFinite(Number(schedule.interval_days))
                ? Number(schedule.interval_days)
                : 0,
        };
    }

    _ensureScheduleData() {
        if (!Array.isArray(this.scheduleData)) {
            this.scheduleData = Array.from({ length: MONTH_COUNT }, () => ({
                hours: [],
                stations: {},
                interval_days: 0,
            }));
        }

        if (!this.scheduleData[this.currentMonth]) {
            this.scheduleData[this.currentMonth] = {
                hours: [],
                stations: {},
                interval_days: 0,
            };
        }

        const monthSchedule = this.scheduleData[this.currentMonth];

        if (!Array.isArray(monthSchedule.hours)) {
            monthSchedule.hours = [];
        }

        if (!monthSchedule.stations || typeof monthSchedule.stations !== "object") {
            monthSchedule.stations = {};
        }

        if (!Number.isFinite(Number(monthSchedule.interval_days))) {
            monthSchedule.interval_days = 0;
        }

        return monthSchedule;
    }

    _markDirty() {
        const wasDirty = this._isDirty;
        this._isDirty = true;

        if (!wasDirty) {
            this._patchNotices();
        }
    }

    _formatMonthName(monthIndex) {
        // Home Assistant users pick their language in Home Assistant, not in the
        // browser, so prefer the frontend locale over the browser default.
        const locale = this._hass?.locale?.language || undefined;

        return new Date(2026, monthIndex, 1).toLocaleString(locale, {
            month: "long",
        });
    }

    _normalizeTimeForInput(value) {
        if (!value) {
            return "";
        }

        const str = String(value);
        return str.length >= 5 ? str.slice(0, 5) : str;
    }

    _normalizeTimeForStorage(value) {
        const str = String(value ?? "").trim();

        if (/^\d{2}:\d{2}:\d{2}$/.test(str)) {
            return str;
        }

        if (/^\d{2}:\d{2}$/.test(str)) {
            return `${str}:00`;
        }

        return null;
    }

    _duplicateHours() {
        const seen = new Set();
        const duplicates = new Set();

        this._getMonthSchedule().hours.forEach((hour) => {
            const normalized = this._normalizeTimeForStorage(hour);

            if (!normalized) {
                return;
            }

            if (seen.has(normalized)) {
                duplicates.add(normalized);
            }

            seen.add(normalized);
        });

        return [...duplicates];
    }

    _changeMonth(delta) {
        this.currentMonth = (this.currentMonth + delta + MONTH_COUNT) % MONTH_COUNT;
        this._copyConfirm = null;
        this.render();
    }

    _selectMonth(monthIndex) {
        this.currentMonth = Number(monthIndex);
        this._copyConfirm = null;
        this.render();
    }

    _updateIntervalDays(value, { commit = false } = {}) {
        const str = String(value ?? "").trim();

        // An empty field is a half-typed number, not a request to set 0. Writing
        // it through on every keystroke silently reset the interval whenever the
        // user cleared the box to retype it.
        if (str === "") {
            if (commit) {
                this._ensureScheduleData();
                this.render();
            }

            return;
        }

        const parsed = parseInt(str, 10);

        if (!Number.isFinite(parsed)) {
            return;
        }

        const monthSchedule = this._ensureScheduleData();
        monthSchedule.interval_days = Math.min(MAX_INTERVAL_DAYS, Math.max(0, parsed));
        this._markDirty();

        if (commit && monthSchedule.interval_days !== parsed) {
            this.render();
        }
    }

    _addTimeSlot() {
        const monthSchedule = this._ensureScheduleData();
        monthSchedule.hours.push(DEFAULT_TIME);
        this._markDirty();
        this.render();
    }

    _updateTimeSlot(index, value, { commit = false } = {}) {
        const monthSchedule = this._ensureScheduleData();

        if (!Number.isInteger(index) || index < 0 || index >= monthSchedule.hours.length) {
            return;
        }

        const normalized = this._normalizeTimeForStorage(value);

        // A time input reports an empty value while it is being retyped. The old
        // code turned that into 07:00:00 straight away, overwriting whatever the
        // user was in the middle of editing.
        if (!normalized) {
            if (commit) {
                this.render();
            }

            return;
        }

        monthSchedule.hours[index] = normalized;
        this._markDirty();

        if (commit) {
            this._patchNotices();
        }
    }

    _removeTimeSlot(index) {
        const monthSchedule = this._ensureScheduleData();

        if (index < 0 || index >= monthSchedule.hours.length) {
            return;
        }

        monthSchedule.hours.splice(index, 1);
        this._markDirty();
        this.render();
    }

    _sortTimeSlots() {
        const monthSchedule = this._ensureScheduleData();
        const before = monthSchedule.hours.join("|");

        monthSchedule.hours = monthSchedule.hours
            .map((hour) => this._normalizeTimeForStorage(hour) || DEFAULT_TIME)
            .sort();

        if (monthSchedule.hours.join("|") !== before) {
            this._markDirty();
        }

        this.render();
    }

    _removeDuplicateTimeSlots() {
        const monthSchedule = this._ensureScheduleData();
        const seen = new Set();
        const unique = [];

        monthSchedule.hours.forEach((hour) => {
            const normalized = this._normalizeTimeForStorage(hour) || DEFAULT_TIME;

            if (seen.has(normalized)) {
                return;
            }

            seen.add(normalized);
            unique.push(normalized);
        });

        const removed = monthSchedule.hours.length - unique.length;
        monthSchedule.hours = unique.sort();

        if (removed > 0) {
            this._markDirty();
            this._setStatus(
                `Removed ${removed} duplicate ${removed === 1 ? "time" : "times"}.`,
                "success"
            );
        }

        this.render();
    }

    _updateStationTime(stationKey, value, { commit = false } = {}) {
        const str = String(value ?? "").trim();

        if (str === "") {
            if (commit) {
                this.render();
            }

            return;
        }

        const parsed = parseInt(str, 10);

        if (!Number.isFinite(parsed)) {
            return;
        }

        const monthSchedule = this._ensureScheduleData();
        const clamped = Math.min(MAX_STATION_MINUTES, Math.max(0, parsed));
        monthSchedule.stations[stationKey] = clamped;
        this._markDirty();

        if (commit && clamped !== parsed) {
            this.render();
        }
    }

    _requestCopyMonth(target) {
        if (!target) {
            return;
        }

        this._copyConfirm = target;
        this.render();
    }

    _cancelCopyMonth() {
        this._copyConfirm = null;
        this.render();
    }

    _copyMonthTo(target) {
        const source = this._ensureScheduleData();
        const targets = this._copyTargetIndexes(target);

        targets.forEach((monthIndex) => {
            this.scheduleData[monthIndex] = {
                hours: [...source.hours],
                stations: { ...source.stations },
                interval_days: source.interval_days,
            };
        });

        this._copyConfirm = null;
        this._markDirty();
        this.render();
        this._setStatus(
            `Copied ${this._formatMonthName(this.currentMonth)} to ` +
            `${targets.length} ${targets.length === 1 ? "month" : "months"}. ` +
            "Not saved yet.",
            "success"
        );
    }

    _copyTargetIndexes(target) {
        const all = Array.from({ length: MONTH_COUNT }, (_, index) => index);

        if (target === "rest") {
            return all.filter((index) => index > this.currentMonth);
        }

        return all.filter((index) => index !== this.currentMonth);
    }

    _copyTargetLabel(target) {
        const count = this._copyTargetIndexes(target).length;
        const noun = count === 1 ? "month" : "months";

        return target === "rest"
            ? `the remaining ${count} ${noun} of the year`
            : `the other ${count} ${noun}`;
    }

    _setStatus(message, type = "info") {
        this._status = { message, type };

        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
            this._statusTimer = null;
        }

        // Errors stay until the next action: a 3.5s timer meant a failed save
        // could vanish before the user looked at the card.
        if (type !== "error") {
            this._statusTimer = setTimeout(() => {
                this._status = null;
                this._patchStatus();
            }, 5000);
        }

        this._patchStatus();
    }

    _patchStatus() {
        const node = this.shadowRoot?.querySelector("[data-role='status']");

        // Patch the node instead of re-rendering: every render() replaces the
        // whole shadow DOM, so the status timer used to wipe the field the user
        // was typing into a few seconds after a save.
        if (!node) {
            this.render();
            return;
        }

        node.className = `status ${this._status?.type || ""}`;
        node.textContent = this._status?.message || "";
    }

    _patchNotices() {
        const root = this.shadowRoot;

        if (!root?.querySelector("[data-role='dirty-badge']")) {
            this.render();
            return;
        }

        root.querySelector("[data-role='dirty-badge']").hidden = !this._isDirty;

        const externalNotice = root.querySelector("[data-role='external-notice']");
        if (externalNotice) {
            externalNotice.hidden = !this._externalChangePending;
        }

        const duplicates = this._duplicateHours();
        const duplicateNotice = root.querySelector("[data-role='duplicate-notice']");
        if (duplicateNotice) {
            duplicateNotice.hidden = duplicates.length === 0;
            const text = duplicateNotice.querySelector("[data-role='duplicate-text']");
            if (text) {
                text.textContent =
                    `Duplicate times (${duplicates.join(", ")}) count twice ` +
                    "towards the daily target.";
            }
        }

        const saveButton = root.querySelector("[data-action='save-schedule']");
        if (saveButton) {
            saveButton.disabled = !this.scheduleData || !this._isDirty;
        }
    }

    async _saveSchedule() {
        if (!this._hass) {
            this._setStatus("Home Assistant is not ready yet.", "error");
            return;
        }

        if (!this._servicePrefix) {
            this._setStatus(
                "Could not determine the schedule service for this controller.",
                "error"
            );
            return;
        }

        const scheduleArray = Array.isArray(this.scheduleData)
            ? this.scheduleData.map((monthSchedule) => ({
                hours: Array.isArray(monthSchedule?.hours)
                    ? monthSchedule.hours
                        .map((hour) => this._normalizeTimeForStorage(hour))
                        .filter(Boolean)
                    : [],
                stations:
                    monthSchedule?.stations && typeof monthSchedule.stations === "object"
                        ? { ...monthSchedule.stations }
                        : {},
                interval_days: Math.max(0, parseInt(monthSchedule?.interval_days, 10) || 0),
            }))
            : [];

        try {
            await this._hass.callService(
                "smart_water_controller",
                `set_irrigation_schedule_${this._servicePrefix}`,
                { schedule: scheduleArray }
            );

            this._isDirty = false;
            this._pendingEntitySync = false;
            this._externalChangePending = false;
            this._lastLoadedScheduleJson = JSON.stringify(scheduleArray);
            this.render();
            this._setStatus("Schedule saved successfully.", "success");
        } catch (error) {
            this._setStatus(
                error?.message || "Failed to save the schedule.",
                "error"
            );
        }
    }

    _captureFocus() {
        const element = this.shadowRoot?.activeElement;

        if (!element?.dataset) {
            return null;
        }

        const snapshot = {
            role: element.dataset.role ?? null,
            action: element.dataset.action ?? null,
            index: element.dataset.index ?? null,
            stationKey: element.dataset.stationKey ?? null,
            start: null,
            end: null,
        };

        try {
            snapshot.start = element.selectionStart;
            snapshot.end = element.selectionEnd;
        } catch (error) {
            // Not all input types expose a selection; the focus alone is enough.
        }

        return snapshot.role || snapshot.action ? snapshot : null;
    }

    _restoreFocus(snapshot) {
        if (!snapshot) {
            return;
        }

        const parts = [];

        if (snapshot.role) {
            parts.push(`[data-role="${snapshot.role}"]`);
        }

        if (snapshot.action) {
            parts.push(`[data-action="${snapshot.action}"]`);
        }

        if (snapshot.index !== null) {
            parts.push(`[data-index="${snapshot.index}"]`);
        }

        if (snapshot.stationKey !== null) {
            parts.push(`[data-station-key="${snapshot.stationKey}"]`);
        }

        const target = this.shadowRoot?.querySelector(parts.join(""));

        if (!target) {
            return;
        }

        target.focus();

        if (snapshot.start !== null && snapshot.end !== null) {
            try {
                target.setSelectionRange(snapshot.start, snapshot.end);
            } catch (error) {
                // Same as above: selection is best effort.
            }
        }
    }

    _attachEventListeners() {
        const root = this.shadowRoot;
        if (!root) {
            return;
        }

        root.querySelector("[data-action='prev-month']")?.addEventListener("click", () => {
            this._changeMonth(-1);
        });

        root.querySelector("[data-action='next-month']")?.addEventListener("click", () => {
            this._changeMonth(1);
        });

        root.querySelector("[data-role='month-select']")?.addEventListener("change", (event) => {
            this._selectMonth(event.target.value);
        });

        root.querySelector("[data-action='add-time']")?.addEventListener("click", () => {
            this._addTimeSlot();
        });

        root.querySelector("[data-action='sort-times']")?.addEventListener("click", () => {
            this._sortTimeSlots();
        });

        root.querySelector("[data-action='dedupe-times']")?.addEventListener("click", () => {
            this._removeDuplicateTimeSlots();
        });

        root.querySelector("[data-action='save-schedule']")?.addEventListener("click", () => {
            this._saveSchedule();
        });

        root.querySelector("[data-action='reload-schedule']")?.addEventListener("click", () => {
            this._reloadFromEntity();
        });

        root.querySelector("[data-action='request-copy']")?.addEventListener("click", () => {
            const target = root.querySelector("[data-role='copy-target']")?.value;
            this._requestCopyMonth(target);
        });

        root.querySelector("[data-action='confirm-copy']")?.addEventListener("click", () => {
            this._copyMonthTo(this._copyConfirm);
        });

        root.querySelector("[data-action='cancel-copy']")?.addEventListener("click", () => {
            this._cancelCopyMonth();
        });

        const intervalInput = root.querySelector("[data-role='interval-days']");
        intervalInput?.addEventListener("input", (event) => {
            this._updateIntervalDays(event.target.value);
        });
        intervalInput?.addEventListener("change", (event) => {
            this._updateIntervalDays(event.target.value, { commit: true });
        });

        root.querySelectorAll("[data-role='time-slot']").forEach((input) => {
            input.addEventListener("input", (event) => {
                const index = Number(event.currentTarget.dataset.index);
                this._updateTimeSlot(index, event.currentTarget.value);
            });

            input.addEventListener("change", (event) => {
                const index = Number(event.currentTarget.dataset.index);
                this._updateTimeSlot(index, event.currentTarget.value, { commit: true });
            });
        });

        root.querySelectorAll("[data-action='remove-time']").forEach((button) => {
            button.addEventListener("click", (event) => {
                const index = Number(event.currentTarget.dataset.index);
                this._removeTimeSlot(index);
            });
        });

        root.querySelectorAll("[data-role='station-minutes']").forEach((input) => {
            input.addEventListener("input", (event) => {
                const stationKey = event.currentTarget.dataset.stationKey;
                this._updateStationTime(stationKey, event.currentTarget.value);
            });

            input.addEventListener("change", (event) => {
                const stationKey = event.currentTarget.dataset.stationKey;
                this._updateStationTime(stationKey, event.currentTarget.value, {
                    commit: true,
                });
            });
        });
    }

    _renderTimeRows(monthSchedule) {
        if (monthSchedule.hours.length === 0) {
            return `
                <p class="empty-hint">
                    No times configured for this month, so nothing will be watered.
                </p>
            `;
        }

        return monthSchedule.hours.map((hour, index) => {
            const display = this._normalizeTimeForInput(hour);

            return `
                <div class="time-row">
                    <input
                        class="time-field"
                        type="time"
                        value="${escapeAttribute(display)}"
                        aria-label="Watering time ${index + 1}"
                        data-role="time-slot"
                        data-index="${index}"
                    >
                    <button
                        class="danger-button"
                        type="button"
                        data-action="remove-time"
                        data-index="${index}"
                        aria-label="Remove time ${escapeAttribute(display)}"
                    >
                        <span class="button-icon danger-icon">
                            <ha-icon icon="mdi:close"></ha-icon>
                        </span>
                    </button>
                </div>
            `;
        }).join("");
    }

    _renderStationRows(monthSchedule) {
        const stationCount = this._getStationCount();

        if (stationCount === 0) {
            return `
                <p class="empty-hint">
                    No stations reported by the integration yet.
                </p>
            `;
        }

        return Array.from({ length: stationCount }, (_, offset) => {
            const stationId = offset + 1;
            const stationKey = `station_${stationId}_minutes`;
            const minutes = Number(monthSchedule.stations?.[stationKey]) || 0;
            const label = this._getStationLabel(stationId);

            return `
                <div class="station-row">
                    <div class="station-label">${escapeText(label)}</div>
                    <input
                        class="field"
                        type="number"
                        min="0"
                        max="${MAX_STATION_MINUTES}"
                        step="1"
                        inputmode="numeric"
                        value="${escapeAttribute(minutes)}"
                        aria-label="Minutes for ${escapeAttribute(label)}"
                        data-role="station-minutes"
                        data-station-key="${escapeAttribute(stationKey)}"
                    >
                </div>
            `;
        }).join("");
    }

    // The schedule repeats every year, so a month on its own does not pin down
    // a calendar: the weekdays differ. "June" asked in October means next June,
    // and the year is printed in the heading so the choice is never implicit.
    _getDisplayYear(monthIndex = this.currentMonth) {
        const now = new Date();

        return monthIndex >= now.getMonth() ? now.getFullYear() : now.getFullYear() + 1;
    }

    _getFirstWeekday() {
        return this._hass?.locale?.first_weekday === "sunday" ? 0 : 1;
    }

    _renderCalendar(monthSchedule) {
        const year = this._getDisplayYear();
        const context = this._getIntervalContext();
        const projection = projectWateringDays({
            year,
            monthIndex: this.currentMonth,
            hours: monthSchedule.hours,
            intervalDays: monthSchedule.interval_days,
            anchor: context.anchor,
            blockedToday: context.blockedToday,
        });

        const firstWeekday = this._getFirstWeekday();
        // Walk out from the Sunday of an arbitrary week rather than assuming
        // which weekday a hardcoded date fell on.
        const reference = new Date(2026, 1, 1);
        const sunday = reference.getDate() - reference.getDay();
        const weekdays = Array.from({ length: 7 }, (_, offset) =>
            new Date(2026, 1, sunday + ((firstWeekday + offset) % 7)).toLocaleString(
                this._hass?.locale?.language || undefined,
                { weekday: "short" }
            )
        );

        const leading = (projection.days[0].weekday - firstWeekday + 7) % 7;

        const cells = [
            ...Array.from({ length: leading }, () => '<div class="cal-cell empty"></div>'),
            ...projection.days.map((entry) => {
                const classes = ["cal-cell"];

                if (entry.waters) {
                    classes.push("waters");
                }
                if (entry.isToday) {
                    classes.push("today");
                }
                if (entry.blocked) {
                    classes.push("blocked");
                }
                if (entry.isPast) {
                    classes.push("past");
                }

                const label = entry.waters
                    ? `${entry.day}: ${projection.hours.join(", ")}`
                    : String(entry.day);

                return `
                    <div class="${classes.join(" ")}" title="${escapeAttribute(label)}">
                        <span class="cal-day">${entry.day}</span>
                        ${entry.waters ? '<span class="cal-dot"></span>' : ""}
                    </div>
                `;
            }),
        ].join("");

        const stationMinutes = Object.values(monthSchedule.stations ?? {})
            .reduce((total, value) => total + (Number(value) || 0), 0);

        let note;

        if (!projection.hours.length) {
            note = "No times configured for this month, so no day waters.";
        } else if (!stationMinutes) {
            note =
                "Times are set but every station is at 0 minutes, so these days " +
                "start nothing.";
        } else if (projection.mode === "projected") {
            const until = context.blockedUntil
                ? ` Watering is on hold until ${escapeText(context.blockedUntil)}.`
                : "";

            note =
                "Projected from the last rain or sprinkle, at unchanged weather. " +
                "Rain resets the interval, so these days can move." + until;
        } else {
            note =
                `The pattern of the rule - every ${projection.intervalDays} ` +
                `${projection.intervalDays === 1 ? "day" : "days"} from the 1st. ` +
                "The real days depend on when it last rained, which is only " +
                "known for the current month.";
        }

        return `
            <section class="section">
                <h3 class="section-title">
                    Calendar ${escapeText(this._formatMonthName(this.currentMonth))} ${year}
                </h3>
                <p class="section-description">${note}</p>

                <div class="cal-grid" role="grid" aria-label="Watering days">
                    ${weekdays.map((name) => `
                        <div class="cal-weekday">${escapeText(name)}</div>
                    `).join("")}
                    ${cells}
                </div>

                <div class="cal-legend">
                    <span class="cal-legend-item"><span class="cal-dot"></span>waters</span>
                    <span class="cal-legend-item"><span class="cal-swatch today"></span>today</span>
                    <span class="cal-legend-item"><span class="cal-swatch past"></span>past, not recorded here</span>
                </div>
            </section>
        `;
    }

    render() {
        if (!this.shadowRoot) {
            return;
        }

        const focusSnapshot = this._captureFocus();

        const entity = this._getEntity();
        const monthSchedule = this._getMonthSchedule();
        const monthName = this._formatMonthName(this.currentMonth);
        const showHeader = this._shouldShowHeader();
        const headerTitle = this._getHeaderTitle();
        const duplicates = this._duplicateHours();

        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                }

                * {
                    box-sizing: border-box;
                }

                ha-card {
                    overflow: hidden;
                }

                .wrapper {
                    padding: 16px;
                }

                .card-header {
                    margin: 0 0 12px;
                }

                .card-header-title {
                    margin: 0;
                    color: var(--ha-card-header-color, var(--primary-text-color));
                    font-family: var(--ha-card-header-font-family, inherit);
                    font-size: var(--ha-card-header-font-size, var(--ha-font-size-2xl));
                    font-weight: var(--ha-font-weight-normal);
                    letter-spacing: -0.012em;
                    line-height: var(--ha-line-height-expanded);
                }

                .card-header-title .name {
                    display: block;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .month-header {
                    display: grid;
                    grid-template-columns: auto minmax(0, 1fr) auto;
                    align-items: center;
                    gap: 12px;
                    margin-bottom: 20px;
                }

                .icon-button {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 40px;
                    height: 40px;
                    border: 1px solid var(--divider-color);
                    border-radius: 999px;
                    background: var(--ha-card-background, var(--card-background-color, #fff));
                    color: var(--primary-text-color);
                    cursor: pointer;
                    transition: background-color 160ms ease, border-color 160ms ease, transform 120ms ease;
                }

                .icon-button:hover {
                    background: var(--secondary-background-color);
                }

                .icon-button:active {
                    transform: scale(0.98);
                }

                .icon-button ha-icon {
                    display: block;
                    width: 20px;
                    height: 20px;
                    margin: 0;
                    color: var(--secondary-text-color);
                }

                .month-select-wrap {
                    position: relative;
                }

                .month-select {
                    width: 100%;
                    height: 44px;
                    padding: 0 40px 0 14px;
                    border: 1px solid var(--divider-color);
                    border-radius: 12px;
                    background: var(--ha-card-background, var(--card-background-color, #fff));
                    color: var(--primary-text-color);
                    font: inherit;
                    font-size: 16px;
                    font-weight: 500;
                    appearance: none;
                    outline: none;
                    cursor: pointer;
                }

                .month-select:focus,
                .field:focus,
                .time-field:focus,
                .compact-select:focus {
                    border-color: var(--primary-color);
                    box-shadow: 0 0 0 1px var(--primary-color);
                }

                .month-select-wrap ha-icon {
                    position: absolute;
                    right: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 20px;
                    height: 20px;
                    color: var(--secondary-text-color);
                    pointer-events: none;
                }

                .section {
                    padding: 16px;
                    border: 1px solid var(--divider-color);
                    border-radius: 16px;
                    background: color-mix(
                        in srgb,
                        var(--ha-card-background, var(--card-background-color, #fff)) 92%,
                        var(--primary-text-color) 8%
                    );
                }

                .section + .section {
                    margin-top: 16px;
                }

                .section-heading {
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 10px;
                    flex-wrap: wrap;
                }

                .section-title {
                    margin: 0 0 4px;
                    font-size: 16px;
                    font-weight: 600;
                    color: var(--primary-text-color);
                }

                .section-description {
                    margin: 0 0 14px;
                    color: var(--secondary-text-color);
                    font-size: 13px;
                    line-height: 1.4;
                }

                .field,
                .time-field {
                    width: 100%;
                    min-height: 44px;
                    padding: 10px 12px;
                    border: 1px solid var(--divider-color);
                    border-radius: 12px;
                    background: var(--ha-card-background, var(--card-background-color, #fff));
                    color: var(--primary-text-color);
                    font: inherit;
                    outline: none;
                }

                .time-list {
                    display: grid;
                    gap: 12px;
                }

                .time-row {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) auto;
                    gap: 10px;
                    align-items: center;
                }

                .danger-button,
                .add-button,
                .save-button,
                .quiet-button {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    min-height: 40px;
                    padding: 0 14px;
                    border-radius: 999px;
                    border: 1px solid transparent;
                    font: inherit;
                    font-weight: 500;
                    line-height: 1;
                    cursor: pointer;
                    transition: filter 160ms ease, transform 120ms ease, background-color 160ms ease;
                }

                .danger-button:active,
                .add-button:active,
                .save-button:active,
                .quiet-button:active {
                    transform: scale(0.99);
                }

                .danger-button {
                    width: 40px;
                    min-width: 40px;
                    padding: 0;
                    border-color: color-mix(in srgb, var(--error-color) 30%, transparent);
                    background: color-mix(in srgb, var(--error-color) 12%, transparent);
                    color: var(--error-color);
                }

                .danger-button ha-icon,
                .add-button ha-icon,
                .save-button ha-icon,
                .quiet-button ha-icon {
                    display: block;
                    width: 18px;
                    height: 18px;
                    margin: 0;
                }

                .add-button {
                    margin-top: 14px;
                    background: color-mix(in srgb, var(--primary-color) 12%, transparent);
                    color: var(--primary-color);
                    border-color: color-mix(in srgb, var(--primary-color) 28%, transparent);
                }

                .quiet-button {
                    min-height: 32px;
                    padding: 0 12px;
                    font-size: 13px;
                    border-color: var(--divider-color);
                    background: transparent;
                    color: var(--secondary-text-color);
                }

                .quiet-button:hover {
                    background: var(--secondary-background-color);
                }

                .save-button {
                    background: var(--primary-color);
                    color: var(--text-primary-color, #fff);
                    min-width: 110px;
                }

                .button-icon {
                    display: inline-grid;
                    place-items: center;
                    line-height: 0;
                    flex: 0 0 auto;
                }

                .nav-icon {
                    width: 20px;
                    height: 20px;
                }

                .nav-icon-prev {
                    transform: translate(-1px, -2px);
                }

                .nav-icon-next {
                    transform: translate(1px, -2px);
                }

                .danger-icon {
                    width: 18px;
                    height: 18px;
                    transform: translate(-2px, -2.5px);
                }

                .add-icon {
                    width: 18px;
                    height: 18px;
                    transform: translate(-1px, -2.5px);
                }

                .save-icon {
                    width: 18px;
                    height: 18px;
                    transform: translate(-1px, -2.5px);
                }

                .station-list {
                    display: grid;
                    gap: 12px;
                }

                .station-row {
                    display: grid;
                    grid-template-columns: minmax(110px, auto) minmax(0, 1fr);
                    gap: 12px;
                    align-items: center;
                }

                .station-label {
                    color: var(--primary-text-color);
                    font-weight: 500;
                }

                .time-tools {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                    margin-bottom: 12px;
                }

                .copy-row {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) auto;
                    gap: 10px;
                    align-items: center;
                }

                .compact-select {
                    width: 100%;
                    min-height: 40px;
                    padding: 0 12px;
                    border: 1px solid var(--divider-color);
                    border-radius: 12px;
                    background: var(--ha-card-background, var(--card-background-color, #fff));
                    color: var(--primary-text-color);
                    font: inherit;
                    outline: none;
                    cursor: pointer;
                }

                .confirm-bar {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 10px;
                    flex-wrap: wrap;
                    margin-top: 12px;
                    padding: 10px 12px;
                    border-radius: 12px;
                    border: 1px solid color-mix(in srgb, var(--warning-color, #fb8c00) 40%, transparent);
                    background: color-mix(in srgb, var(--warning-color, #fb8c00) 12%, transparent);
                    color: var(--primary-text-color);
                    font-size: 13px;
                }

                .confirm-actions {
                    display: flex;
                    gap: 8px;
                }

                .notice {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 14px;
                    padding: 10px 12px;
                    border-radius: 12px;
                    font-size: 13px;
                    line-height: 1.4;
                }

                .notice[hidden] {
                    display: none;
                }

                .notice ha-icon {
                    flex: 0 0 auto;
                    width: 18px;
                    height: 18px;
                }

                .notice.warning {
                    border: 1px solid color-mix(in srgb, var(--warning-color, #fb8c00) 40%, transparent);
                    background: color-mix(in srgb, var(--warning-color, #fb8c00) 12%, transparent);
                    color: var(--primary-text-color);
                }

                .badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 3px 10px;
                    border-radius: 999px;
                    font-size: 12px;
                    font-weight: 500;
                    background: color-mix(in srgb, var(--warning-color, #fb8c00) 18%, transparent);
                    color: var(--primary-text-color);
                    border: 1px solid color-mix(in srgb, var(--warning-color, #fb8c00) 40%, transparent);
                }

                .badge[hidden] {
                    display: none;
                }

                .footer {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 12px;
                    margin-top: 18px;
                    flex-wrap: wrap;
                }

                .footer-actions {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .status {
                    min-height: 20px;
                    font-size: 13px;
                    color: var(--secondary-text-color);
                }

                .status.success {
                    color: var(--success-color, #2e7d32);
                }

                .status.error {
                    color: var(--error-color);
                }

                .save-button[disabled] {
                    opacity: 0.6;
                    cursor: default;
                }

                .empty-hint {
                    margin: 0;
                    color: var(--secondary-text-color);
                    font-size: 13px;
                }

                .placeholder {
                    padding: 18px 0 6px;
                    color: var(--secondary-text-color);
                }

                .cal-grid {
                    display: grid;
                    grid-template-columns: repeat(7, 1fr);
                    gap: 4px;
                }

                .cal-weekday {
                    text-align: center;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--secondary-text-color);
                    padding-bottom: 2px;
                }

                .cal-cell {
                    position: relative;
                    aspect-ratio: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 2px;
                    border-radius: 8px;
                    font-size: 13px;
                    background: var(--secondary-background-color);
                    color: var(--primary-text-color);
                }

                .cal-cell.empty {
                    background: none;
                }

                .cal-cell.past {
                    opacity: 0.45;
                }

                .cal-cell.waters {
                    background: color-mix(in srgb, var(--primary-color) 18%, transparent);
                    font-weight: 500;
                }

                .cal-cell.today {
                    outline: 2px solid var(--primary-color);
                    outline-offset: -2px;
                }

                .cal-cell.blocked .cal-day {
                    text-decoration: line-through;
                }

                .cal-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: var(--primary-color);
                }

                .cal-legend {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 14px;
                    margin-top: 10px;
                    font-size: 12px;
                    color: var(--secondary-text-color);
                }

                .cal-legend-item {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                }

                .cal-swatch {
                    width: 12px;
                    height: 12px;
                    border-radius: 4px;
                    background: var(--secondary-background-color);
                }

                .cal-swatch.today {
                    background: none;
                    border: 2px solid var(--primary-color);
                }

                .cal-swatch.past {
                    opacity: 0.45;
                }

                @media (max-width: 520px) {
                    .wrapper {
                        padding: 12px;
                    }

                    .month-header {
                        grid-template-columns: 40px minmax(0, 1fr) 40px;
                        gap: 10px;
                    }

                    .station-row {
                        grid-template-columns: 1fr;
                        gap: 8px;
                    }

                    .copy-row {
                        grid-template-columns: 1fr;
                    }

                    .footer {
                        align-items: stretch;
                    }

                    .footer-actions {
                        width: 100%;
                    }

                    .save-button {
                        flex: 1;
                        justify-content: center;
                    }
                }
            </style>

            <ha-card>
                <div class="wrapper">
                    ${showHeader ? `
                        <div class="card-header">
                            <div class="card-header-title">
                                <div class="name">${escapeText(headerTitle)}</div>
                            </div>
                        </div>
                    ` : ""}

                    <div class="month-header">
                        <button class="icon-button" type="button" data-action="prev-month" aria-label="Previous month">
                            <span class="button-icon nav-icon nav-icon-prev">
                                <ha-icon icon="mdi:chevron-left"></ha-icon>
                            </span>
                        </button>

                        <div class="month-select-wrap">
                            <select class="month-select" data-role="month-select" aria-label="Month">
                                ${Array.from({ length: MONTH_COUNT }, (_, index) => `
                                    <option value="${index}" ${index === this.currentMonth ? "selected" : ""}>
                                        ${escapeText(this._formatMonthName(index))}
                                    </option>
                                `).join("")}
                            </select>
                            <ha-icon icon="mdi:chevron-down"></ha-icon>
                        </div>

                        <button class="icon-button" type="button" data-action="next-month" aria-label="Next month">
                            <span class="button-icon nav-icon nav-icon-next">
                                <ha-icon icon="mdi:chevron-right"></ha-icon>
                            </span>
                        </button>
                    </div>

                    <div class="notice warning" data-role="external-notice" ${this._externalChangePending ? "" : "hidden"}>
                        <ha-icon icon="mdi:alert-outline"></ha-icon>
                        <span>
                            The schedule changed in Home Assistant while you were editing.
                            Saving will overwrite it; use Reload to discard your edits.
                        </span>
                    </div>

                    <div class="notice warning" data-role="duplicate-notice" ${duplicates.length ? "" : "hidden"}>
                        <ha-icon icon="mdi:alert-outline"></ha-icon>
                        <span data-role="duplicate-text">
                            Duplicate times (${escapeText(duplicates.join(", "))}) count twice
                            towards the daily target.
                        </span>
                    </div>

                    ${this.scheduleData && this._config?.calendar !== false
                        ? this._renderCalendar(monthSchedule)
                        : ""}

                    ${this.scheduleData ? `
                        <section class="section">
                            <h3 class="section-title">Interval between sprinkles</h3>
                            <p class="section-description">
                                Number of days between watering cycles for ${escapeText(monthName)}.
                                Use 0 or 1 to water every day.
                            </p>
                            <input
                                class="field"
                                type="number"
                                min="0"
                                max="${MAX_INTERVAL_DAYS}"
                                step="1"
                                inputmode="numeric"
                                value="${escapeAttribute(monthSchedule.interval_days)}"
                                aria-label="Days between watering cycles"
                                data-role="interval-days"
                            >
                        </section>

                        <section class="section">
                            <h3 class="section-title">Scheduled times</h3>
                            <p class="section-description">
                                Add one or more times for this month. Times are stored in 24-hour format.
                            </p>

                            ${monthSchedule.hours.length > 1 ? `
                                <div class="time-tools">
                                    <button class="quiet-button" type="button" data-action="sort-times">
                                        <ha-icon icon="mdi:sort-clock-ascending-outline"></ha-icon>
                                        <span>Sort</span>
                                    </button>
                                    ${duplicates.length ? `
                                        <button class="quiet-button" type="button" data-action="dedupe-times">
                                            <ha-icon icon="mdi:filter-remove-outline"></ha-icon>
                                            <span>Remove duplicates</span>
                                        </button>
                                    ` : ""}
                                </div>
                            ` : ""}

                            <div class="time-list">
                                ${this._renderTimeRows(monthSchedule)}
                            </div>

                            <button class="add-button" type="button" data-action="add-time">
                                <span class="button-icon add-icon">
                                    <ha-icon icon="mdi:plus"></ha-icon>
                                </span>
                                <span>Add time</span>
                            </button>
                        </section>

                        <section class="section">
                            <h3 class="section-title">Sprinkle time per station</h3>
                            <p class="section-description">
                                Set the watering duration in minutes for each station in
                                ${escapeText(monthName)}. Use 0 to skip a station.
                            </p>

                            <div class="station-list">
                                ${this._renderStationRows(monthSchedule)}
                            </div>
                        </section>

                        <section class="section">
                            <h3 class="section-title">Copy this month</h3>
                            <p class="section-description">
                                Reuse the settings of ${escapeText(monthName)} in other months
                                instead of filling all twelve by hand.
                            </p>

                            <div class="copy-row">
                                <select class="compact-select" data-role="copy-target" aria-label="Copy target">
                                    <option value="rest">To the rest of the year</option>
                                    <option value="all">To all other months</option>
                                </select>
                                <button class="quiet-button" type="button" data-action="request-copy">
                                    <ha-icon icon="mdi:content-copy"></ha-icon>
                                    <span>Copy</span>
                                </button>
                            </div>

                            ${this._copyConfirm ? `
                                <div class="confirm-bar">
                                    <span>
                                        Overwrite ${escapeText(this._copyTargetLabel(this._copyConfirm))}
                                        with ${escapeText(monthName)}?
                                    </span>
                                    <span class="confirm-actions">
                                        <button class="quiet-button" type="button" data-action="cancel-copy">
                                            <span>Cancel</span>
                                        </button>
                                        <button class="quiet-button" type="button" data-action="confirm-copy">
                                            <span>Overwrite</span>
                                        </button>
                                    </span>
                                </div>
                            ` : ""}
                        </section>
                    ` : `
                        <div class="placeholder">
                            ${entity
                                ? "Loading schedule data..."
                                : `Entity not found: ${escapeText(this.sensor)}`}
                        </div>
                    `}

                    <div class="footer">
                        <div class="status ${this._status?.type || ""}" data-role="status">${escapeText(this._status?.message || "")}</div>
                        <div class="footer-actions">
                            <span class="badge" data-role="dirty-badge" ${this._isDirty ? "" : "hidden"}>
                                <ha-icon icon="mdi:pencil-outline"></ha-icon>
                                <span>Unsaved changes</span>
                            </span>
                            <button
                                class="quiet-button"
                                type="button"
                                data-action="reload-schedule"
                                aria-label="Reload the schedule from Home Assistant"
                            >
                                <ha-icon icon="mdi:refresh"></ha-icon>
                                <span>Reload</span>
                            </button>
                            <button
                                class="save-button"
                                type="button"
                                data-action="save-schedule"
                                ${this.scheduleData && this._isDirty ? "" : "disabled"}
                            >
                                <span class="button-icon save-icon">
                                    <ha-icon icon="mdi:content-save"></ha-icon>
                                </span>
                                <span>Save</span>
                            </button>
                        </div>
                    </div>
                </div>
            </ha-card>
        `;

        this._attachEventListeners();
        this._restoreFocus(focusSnapshot);
    }
}

customElements.define("smart-water-controller-schedule-card", IrrigationScheduleCard);

// A stale copy of this bundle served from the browser or service-worker cache
// looks exactly like a card that was never updated, which is impossible to tell
// apart from a bug. Printing the version makes the loaded build checkable.
console.info(
    `%c SMART-WATER-CONTROLLER-SCHEDULE-CARD %c ${CARD_VERSION} `,
    "color: white; background: #03a9f4; font-weight: 700;",
    "color: #03a9f4; background: white; font-weight: 700;",
);

// Without this the card never shows up in the dashboard "Add card" picker, so the
// only way to use it was to know the YAML type by heart.
window.customCards = window.customCards || [];
window.customCards.push({
    type: "smart-water-controller-schedule-card",
    name: "Smart Water Controller Schedule",
    description: "Edit the monthly watering schedule of a Smart Water Controller.",
    preview: false,
    documentationURL: "https://github.com/hcraveiro/smart-water-controller-schedule-card",
});

;
/*
 * Irrigation Schedule - visual harmonization layer, v1.0
 * Keeps the original HACS schedule card and its editing/save logic intact.
 * Register as a JavaScript module resource AFTER the original HACS resource.
 */
(() => {
  const tagName = 'smart-water-controller-schedule-card';
  const marker = 'irrigation-schedule-visual-style';
  const css = `
    :host { display: block; --irrigation-accent: var(--success-color, #43a047); }
    ha-card {
      overflow: hidden;
      border-radius: 18px !important;
      background: var(--ha-card-background, var(--card-background-color)) !important;
      box-shadow: var(--ha-card-box-shadow, none);
    }
    .wrapper { padding: 13px !important; }
    .card-header { margin-bottom: 12px !important; }
    .card-header-title { font-size: 16px !important; font-weight: 650 !important; }
    .month-header {
      grid-template-columns: 38px minmax(0,1fr) 38px !important;
      gap: 8px !important;
      margin-bottom: 12px !important;
    }
    .icon-button {
      width: 38px !important; height: 38px !important;
      border: 0 !important; border-radius: 11px !important;
      background: var(--secondary-background-color, rgba(128,128,128,.09)) !important;
    }
    .icon-button:hover { background: color-mix(in srgb, var(--irrigation-accent) 15%, transparent) !important; }
    .month-select {
      height: 40px !important;
      border: 0 !important;
      border-radius: 11px !important;
      background: var(--secondary-background-color, rgba(128,128,128,.09)) !important;
      font-size: 14px !important;
      font-weight: 650 !important;
    }
    .section {
      padding: 13px !important;
      border: 0 !important;
      border-radius: 12px !important;
      background: var(--secondary-background-color, rgba(128,128,128,.09)) !important;
    }
    .section + .section { margin-top: 9px !important; }
    .section-title { font-size: 13px !important; font-weight: 650 !important; margin: 0 0 3px !important; }
    .section-description {
      font-size: 11px !important;
      line-height: 1.35 !important;
      margin: 0 0 11px !important;
    }
    .field, .time-field {
      min-height: 39px !important;
      padding: 8px 10px !important;
      border: 1px solid var(--divider-color, rgba(128,128,128,.16)) !important;
      border-radius: 10px !important;
      background: var(--ha-card-background, var(--card-background-color)) !important;
      font-size: 13px !important;
      font-variant-numeric: tabular-nums;
    }
    .field:focus, .time-field:focus, .month-select:focus {
      outline: 2px solid var(--irrigation-accent) !important;
      outline-offset: 1px;
    }
    .time-list, .station-list { gap: 8px !important; }
    .time-row { gap: 8px !important; }
    .station-row {
      grid-template-columns: minmax(0, 1fr) 95px !important;
      gap: 10px !important;
      min-height: 40px;
    }
    .station-label {
      font-size: 12px !important;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .station-row .field { text-align: center; }
    .danger-button, .add-button, .save-button {
      min-height: 39px !important;
      border-radius: 10px !important;
      font-size: 12px !important;
      font-weight: 650 !important;
    }
    .danger-button {
      width: 39px !important; min-width: 39px !important;
      background: color-mix(in srgb, var(--error-color, #db4437) 13%, transparent) !important;
    }
    .add-button {
      margin-top: 10px !important;
      border: 0 !important;
      background: color-mix(in srgb, var(--irrigation-accent) 14%, transparent) !important;
      color: var(--irrigation-accent) !important;
    }
    .save-button {
      border: 0 !important;
      background: color-mix(in srgb, var(--irrigation-accent) 18%, transparent) !important;
      color: var(--irrigation-accent) !important;
      min-width: 92px !important;
    }
    .save-button:hover { background: color-mix(in srgb, var(--irrigation-accent) 26%, transparent) !important; }
    .footer { margin-top: 12px !important; gap: 8px !important; }
    .status { font-size: 11px !important; }
    @media (max-width: 520px) {
      .wrapper { padding: 12px !important; }
      .station-row { grid-template-columns: minmax(0,1fr) 84px !important; gap: 7px !important; }
      .station-label { font-size: 11px !important; }
      .footer { flex-direction: row !important; align-items: center !important; }
      .save-button { width: auto !important; }
    }
  `;

  function applyStyle(card) {
    if (!card?.shadowRoot || card.shadowRoot.querySelector(`#${marker}`)) return;
    const style = document.createElement('style');
    style.id = marker;
    style.textContent = css;
    card.shadowRoot.appendChild(style);
  }

  customElements.whenDefined(tagName).then(() => {
    const CardClass = customElements.get(tagName);
    if (!CardClass || CardClass.prototype.__irrigationVisualStylePatched) return;
    CardClass.prototype.__irrigationVisualStylePatched = true;
    const originalRender = CardClass.prototype.render;
    if (typeof originalRender === 'function') {
      CardClass.prototype.render = function (...args) {
        const result = originalRender.apply(this, args);
        applyStyle(this);
        return result;
      };
    }

    // Apply immediately to already-rendered cards, including nested HA shadow roots.
    function visit(root) {
      if (!root?.querySelectorAll) return;
      root.querySelectorAll('*').forEach(element => {
        if (element.localName === tagName) applyStyle(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      });
    }
    visit(document);
  }).catch(error => console.error('Irrigation schedule styling failed:', error));
})();
;
/* RainBird summary cards: overview and weather. Version 1.0. */
class IrrigationSummaryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._expanded = false;
    this._timer = null;
  }

  setConfig(config) {
    if (!['overview', 'weather'].includes(config.mode)) {
      throw new Error('Specify mode: overview or weather');
    }
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
    const ids = Object.values(this._config || {})
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter(value => typeof value === 'string' &&
        /^(sensor|binary_sensor|input_boolean|switch)\./.test(value));
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
  countdown() {
    const end = Date.parse(this.state(this._config.end));
    if (!Number.isFinite(end)) return 'End time unavailable';
    const seconds = Math.max(0, Math.ceil((end-Date.now()) / 1000));
    if (!seconds) return 'Finishing...';
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    const pad = n => String(n).padStart(2,'0');
    return `Stopping in ${h ? `${h}:` : ''}${pad(m)}:${pad(s)}`;
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
  renderOverview() {
    const c = this._config;
    const controller = this.state(c.controller);
    const active = c.zone_statuses.some(id => this.state(id).toLowerCase() === 'sprinkling');
    const lost = this.connectionLost();
    const mode = lost ? 'error' : active ? 'active' : controller.toLowerCase() === 'on' ? 'ready' : 'off';
    const status = lost ? 'Connection lost' : active ? 'Irrigation running' : mode === 'ready' ? 'Irrigation ready' : `Controller ${controller}`;
    const subtitle = lost ? 'Check the RainBird controller' : active ? this.state(c.station) : mode === 'ready' ? 'No active irrigation' : 'Irrigation unavailable';
    return `<div class="hero ${mode}">
      <span class="hero-icon"><ha-icon icon="${active ? 'mdi:water' : lost ? 'mdi:wifi-alert' : 'mdi:sprout'}"></ha-icon></span>
      <div class="hero-copy"><strong>${this.escape(status)}</strong><small>${this.escape(subtitle)}</small>${active ? `<small class="countdown" data-live="countdown">${this.escape(this.countdown())}</small>` : ''}</div>
      <span class="status-dot"></span>
    </div>
    <div class="overview-grid">
      ${this.chip('Next irrigation',this.timeUntil(c.next),'mdi:calendar-clock',c.next)}
      ${this.chip('Last irrigation',this.timeSince(c.last),'mdi:history',c.last)}
      ${this.chip('Controller',controller,'mdi:water-pump',c.controller)}
      ${this.chip('Current station',this.state(c.station),'mdi:sprinkler',c.station)}
    </div>`;
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
    <div class="weather-bottom">${this.row('Last rain',this.timeSince(c.last_rain),c.last_rain,'mdi:history')}${this.row('Total irrigation water',this.value(c.water,2),c.water,'mdi:water')}</div>
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
    if (el) el.textContent = this.countdown();
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
;
/* RainBird expandable irrigation card, v6. Interface and comments in English. */
class IrrigationZonesCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.openZone = -1;
    this.busy = false;
    this.timer = null;
    this.draftDuration = null;
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
        zone.status, zone.today, zone.planned, zone.remaining, zone.valve
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
  valid(value) { return !['unknown','unavailable','none',''].includes(String(value ?? '').toLowerCase()); }
  running(zone) { return String(this.state(zone.status)).toLowerCase() === 'sprinkling'; }
  active() { return this.config?.zones?.find(zone => this.running(zone)); }
  connectionLost() {
    const switches = this.config?.connection_switches || [];
    return switches.some(id => !this.valid(this.state(id)));
  }
  duration() {
    const real = Number(this.state(this.config.duration));
    if (this.draftDuration !== null && Number.isFinite(real) && real === this.draftDuration) this.draftDuration = null;
    return this.draftDuration ?? (this.valid(this.state(this.config.duration)) && Number.isFinite(real) ? real : null);
  }
  durationLimits() {
    const attr = this.entity(this.config.duration)?.attributes || {};
    return {
      min: Number.isFinite(Number(attr.min)) ? Number(attr.min) : 1,
      max: Number.isFinite(Number(attr.max)) ? Number(attr.max) : 120,
      step: Number(this.config.duration_step) > 0 ? Number(this.config.duration_step) : 1
    };
  }
  countdown() {
    const raw = this.state(this.config.end_time);
    if (!this.valid(raw)) return 'End time unavailable';
    const end = Date.parse(raw);
    if (!Number.isFinite(end)) return 'End time unavailable';
    let seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    if (!seconds) return 'Finishing...';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = seconds % 60;
    const pad = n => String(n).padStart(2, '0');
    return 'Stopping in ' + (h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`);
  }
  updateCountdown() {
    this.shadowRoot.querySelectorAll('[data-countdown]').forEach(el => {
      const zone = this.config?.zones?.[Number(el.dataset.countdown)];
      if (zone && this.running(zone)) el.textContent = this.countdown();
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
  async changeDuration(direction) {
    if (this.busy || this.connectionLost() || !this.entity(this.config.duration)) return;
    const current = this.duration();
    if (current === null) return;
    const {min,max,step} = this.durationLimits();
    const next = Math.max(min, Math.min(max, Number((current + direction * step).toFixed(3))));
    if (next === current) return;
    this.busy = true; this.draftDuration = next; this.render();
    try {
      await this._hass.callService('number','set_value',{entity_id:this.config.duration,value:next});
    } catch (error) {
      this.draftDuration = null;
      console.error('Failed to set duration:', error);
      alert('Unable to update irrigation duration.');
    } finally { this.busy = false; this.render(); }
  }
  async press(id, message) {
    if (!id || this.busy || this.connectionLost() || !confirm(message)) return;
    if (this.connectionLost()) return;
    this.busy = true; this.render();
    try {
      await this._hass.callService('button','press',{entity_id:id});
    } catch (error) {
      console.error('Irrigation command failed:',error);
      alert('Unable to execute irrigation command.');
    } finally { this.busy = false; this.render(); }
  }
  start(zone) {
    if (this.connectionLost()) return;
    if (this.active()) { alert('Another irrigation zone is already running. Stop it first.'); return; }
    const minutes = this.duration();
    if (minutes === null) { alert('Irrigation duration is unavailable.'); return; }
    this.press(zone.start, `Start ${zone.name} for ${minutes} minutes?`);
  }
  stop(name) {
    this.press(this.config.stop, name ? `Stop irrigation for ${name}?` : 'Stop all irrigation?');
  }
  render() {
    if (!this.config || !this._hass) return;
    const active = this.active(), duration = this.duration(), {min,max} = this.durationLimits();
    const disconnected = this.connectionLost();
    const rows = this.config.zones.map((zone,index) => {
      const running = this.running(zone), expanded = this.openZone === index, progress = this.progress(zone);
      return `<section class="zone ${running ? 'running' : ''}">
        <button class="summary" data-toggle="${index}" aria-expanded="${expanded}">
          <span class="symbol"><ha-icon icon="${running ? 'mdi:water' : 'mdi:sprinkler-variant'}"></ha-icon></span>
          <span class="title"><strong>${this.esc(zone.name)}</strong><small class="${running ? 'active' : ''}">${this.esc(this.state(zone.status))}</small>${running ? `<small class="countdown" data-countdown="${index}">${this.esc(this.countdown())}</small>` : ''}</span>
          <span class="today"><strong>${this.value(zone.today)}</strong><small>Today</small></span>
          <ha-icon class="chevron" icon="mdi:chevron-${expanded ? 'up':'down'}"></ha-icon>
        </button>
        ${expanded ? `<div class="details">
          <div class="metrics">${this.metric('Status',zone.status)}${this.metric('Irrigated today',zone.today)}${this.metric('Scheduled today',zone.planned)}${this.metric('Remaining today',zone.remaining)}</div>
          ${progress === null ? '' : `<div class="progress-label"><span>Today's schedule</span><strong>${Math.round(progress)}%</strong></div><div class="progress"><div style="width:${progress}%"></div></div>`}
          <div class="controls"><div class="duration"><label>Manual duration</label><div class="stepper">
            <button data-step="-1" ${this.busy || disconnected || duration === null || duration <= min ? 'disabled':''}><ha-icon icon="mdi:minus"></ha-icon></button>
            <button data-info="${this.esc(this.config.duration)}" class="duration-value">${duration ?? '—'} min</button>
            <button data-step="1" ${this.busy || disconnected || duration === null || duration >= max ? 'disabled':''}><ha-icon icon="mdi:plus"></ha-icon></button>
          </div></div><button class="action ${running ? 'stop':'start'}" data-action="${index}" ${this.busy || disconnected || (!running && !!active) ? 'disabled':''}><ha-icon icon="mdi:${running ? 'stop':'play'}"></ha-icon>${running ? 'Stop':'Start'}</button></div>
          ${zone.valve ? `<button class="valve" data-info="${this.esc(zone.valve)}"><ha-icon icon="mdi:valve"></ha-icon>Valve details<ha-icon icon="mdi:chevron-right"></ha-icon></button>` : ''}
        </div>` : ''}</section>`;
    }).join('');
    const globalStop = this.config.show_global_stop && active
      ? `<div class="global"><span><ha-icon icon="mdi:water"></ha-icon> Irrigating: ${this.esc(active.name)}</span><button data-stop-all ${this.busy || disconnected?'disabled':''}><ha-icon icon="mdi:stop-circle-outline"></ha-icon>Stop All</button></div>` : '';
    const connectionWarning = disconnected
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
      small{font-size:12px;color:var(--secondary-text-color)}.title .active,.countdown{color:var(--blue);font-weight:650}.countdown{font-size:11px;font-variant-numeric:tabular-nums}
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
    this.shadowRoot.querySelectorAll('[data-step]').forEach(el => el.addEventListener('click', () => this.changeDuration(Number(el.dataset.step))));
    this.shadowRoot.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => {
      const zone = this.config.zones[Number(el.dataset.action)];
      if (this.running(zone)) this.stop(zone.name); else this.start(zone);
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
