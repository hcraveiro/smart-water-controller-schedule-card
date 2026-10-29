// Station names, the title, entity ids and error messages come from Home
// Assistant or from the dashboard YAML. They are interpolated into innerHTML
// below, so they must be escaped or a name like `<img onerror=...>` would run.
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
// `interval_days` is not a grid on the calendar. Smart Water Controller blocks
// a day when fewer than `interval_days` have passed since the later of the last
// rain and the last sprinkle (ScheduleStateManager.recent_event_blocks_today),
// so rain resets the countdown: "every 2 days" means "two days after the ground
// last got wet", not "even days". Every future day is therefore a projection at
// unchanged weather, and this function keeps that distinction explicit:
//
//   - days before today are never marked. With only the latest anchor and no
//     history, an old anchor would otherwise paint weeks of waterings that
//     never happened;
//   - today comes from the integration's own verdict (`blockedToday`) when it
//     is known, instead of being re-derived here, so the card cannot disagree
//     with the scheduler about the one day that is already decided;
//   - the rest is chained forward, each projected day becoming the next anchor.
//
// `mode` says which of the two readings the caller is showing: "projected" when
// anchored on real data for the month we are actually in, "pattern" when it is
// just the shape of the rule applied from the 1st (any other month, or no
// anchor published), where anchoring would be arithmetic dressed up as a
// forecast.
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

        // The past is not ours to claim, and treating it as an anchor would push
        // the real projection out of phase.
        if (entry.isPast && mode === "projected") {
            return;
        }

        // Today is already decided by the scheduler. This also covers the case
        // the arithmetic gets wrong on its own: the ground got wet earlier
        // *today* and the remaining slots still run, because an event from
        // today does not block today.
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
        this._historyKey = null;
        this._historyByDay = null;
        this._forecastKey = null;
        this._unsubscribeForecast = null;
        this._dailyForecast = null;
        this._selectedCalendarDay = null;

        this.shadowRoot.addEventListener("click", (event) => {
            const cell = event.target.closest?.(".cal-cell[data-day]");
            if (!cell) return;
            const day = Number(cell.dataset.day);
            this._selectedCalendarDay = this._selectedCalendarDay === day ? null : day;
            this.render();
        });
        this.shadowRoot.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const cell = event.target.closest?.(".cal-cell[data-day]");
            if (!cell) return;
            event.preventDefault();
            cell.click();
        });
        this.shadowRoot.addEventListener("focusout", () => {
            window.setTimeout(() => {
                if (!this._hasActiveEditor() && this._pendingEntitySync && !this._isDirty) {
                    this._pendingEntitySync = false;
                    this._syncFromEntity(true);
                }
            }, 0);
        });
    }

    setConfig(config) {
        if (!config?.sensor) {
            throw new Error("You need to define a sensor in config.");
        }

        this._unsubscribeCalendarForecast();
        this._config = config;
        this._historyKey = null;
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
        this._loadCalendarData();

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

        // The schedule changed in Home Assistant while the card holds unsaved
        // edits. The edits are kept, which means saving will overwrite that
        // change: say so instead of leaving the card showing stale data.
        if (this._isDirty && this._scheduleDiffersFromLoaded(entity)) {
            this._externalChangePending = true;
        }

        if (this._hasActiveEditor()) {
            this._pendingEntitySync = true;
            this._patchNotices();
            return;
        }

        this._pendingEntitySync = false;
        this._syncFromEntity();
    }

    getCardSize() {
        // The calendar adds a weekday row, up to six week rows and a legend.
        const calendar = this._config?.calendar === true ? 5 : 0;
        const copy = this._config?.copy_month === true ? 2 : 0;

        return (this._shouldShowHeader() ? 8 : 7) + calendar + copy;
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
            // Rain moves the calendar without the schedule changing at all, so
            // the anchor belongs in the signature or the grid would keep showing
            // yesterday's projection. Only when the calendar is on: otherwise an
            // unrelated change must not redraw the card.
            interval: this._config?.calendar === true ? this._getIntervalContext() : null,
            live_calendar: this._config?.calendar_history === true
                ? this._calendarSourceIds().map((id) => [id, this._hass?.states?.[id]?.state ?? null])
                : null,
            header: Boolean(this._config?.header),
            title: this._getHeaderTitle(),
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

    _getStationLabel(stationKey) {
        const entity = this._getEntity();
        const attrs = entity?.attributes ?? {};
        const stationNames = Array.isArray(attrs.station_names) ? attrs.station_names : [];

        const match = String(stationKey).match(/^station_(\d+)_minutes$/);
        if (match) {
            const stationIndex = Number(match[1]) - 1;
            if (
                Number.isInteger(stationIndex) &&
                stationIndex >= 0 &&
                stationIndex < stationNames.length &&
                stationNames[stationIndex]
            ) {
                return stationNames[stationIndex];
            }
        }

        return String(stationKey)
            .replace("_minutes", "")
            .replace("station_", "Station ");
    }

    // How many stations to offer a row for. Taken from what the integration
    // publishes on the sensor, not from the minutes stored for the current
    // month: a month with nothing stored showed no row at all and could never
    // be configured from the card.
    _getStationCount() {
        const attrs = this._getEntity()?.attributes ?? {};
        const declared = Number(attrs.num_stations);

        if (Number.isInteger(declared) && declared > 0) {
            return declared;
        }

        if (Array.isArray(attrs.station_names) && attrs.station_names.length > 0) {
            return attrs.station_names.length;
        }

        // Last resort, for an integration that publishes neither: the highest
        // station stored anywhere in the schedule.
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

    // Every station of the controller, plus any other key already stored for
    // the month, so nothing in the schedule is hidden from the editor.
    _getStationKeys(monthSchedule) {
        const keys = new Set();

        for (let stationId = 1; stationId <= this._getStationCount(); stationId += 1) {
            keys.add(`station_${stationId}_minutes`);
        }

        Object.keys(monthSchedule.stations || {}).forEach((stationKey) => keys.add(stationKey));

        return [...keys].sort((a, b) => {
            const aNum = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
            const bNum = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
            return aNum - bNum;
        });
    }

    // The sensor that publishes when the schedule last ran and where its
    // interval counts from. Smart Water Controller 1.1.2 and newer put these on
    // the "next schedule" sensor of the same controller. Found, in order, by:
    // the `next_schedule` option, the sibling of the configured sensor
    // (`..._controller_status` -> `..._next_schedule`), or the only sensor that
    // publishes `has_watering_slots`. With several controllers and no option it
    // does not guess, because projecting from another controller's rain would
    // be worse than showing nothing.
    _getNextScheduleEntity() {
        const states = this._hass?.states ?? {};

        if (this._config?.next_schedule) {
            return states[this._config.next_schedule] ?? null;
        }

        const derived = String(this.sensor ?? "").replace(
            /_controller_status$/,
            "_next_schedule"
        );

        if (derived !== this.sensor && states[derived]) {
            return states[derived];
        }

        const candidates = Object.keys(states).filter(
            (entityId) =>
                entityId.startsWith("sensor.") &&
                states[entityId]?.attributes?.has_watering_slots !== undefined
        );

        return candidates.length === 1 ? states[candidates[0]] : null;
    }

    // The anchor the interval counts from, as published by the integration.
    // `last_rain` lives on the weather device, with a different entity prefix,
    // so it cannot be derived from the controller the card was pointed at -
    // which is why the integration republishes it on the next-schedule sensor.
    _getIntervalContext() {
        const attrs = this._getNextScheduleEntity()?.attributes ?? {};

        // Without the published anchor, count from the later of the two, as the
        // scheduler does: a rain after the last sprinkle resets the interval too.
        const wet = [toMidnight(attrs.last_sprinkle), toMidnight(attrs.last_rain)]
            .filter(Boolean);
        const anchor = attrs.interval_anchor
            ? toMidnight(attrs.interval_anchor)
            : wet.length
                ? new Date(Math.max(...wet.map((date) => date.getTime())))
                : null;

        return {
            anchor,
            blockedToday:
                typeof attrs.blocked_today === "boolean" ? attrs.blocked_today : null,
            blockedUntil: attrs.blocked_until ?? null,
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
            this._externalChangePending = false;
        }

        this.render();
    }

    _scheduleDiffersFromLoaded(entity) {
        const schedule = entity?.attributes?.schedule;

        return Boolean(schedule) && JSON.stringify(schedule) !== this._lastLoadedScheduleJson;
    }

    // Throw away the local edits and show what Home Assistant has.
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
            this.scheduleData = Array.from({ length: 12 }, () => ({
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

    // Show or hide the "unsaved changes" badge, the Reload button and the
    // outside-change notice in place. Redrawing would take the focus away from
    // the field being edited, which is when these change.
    _patchNotices() {
        const root = this.shadowRoot;
        const badge = root?.querySelector("[data-role='dirty-badge']");

        if (!badge) {
            this.render();
            return;
        }

        badge.hidden = !this._isDirty;

        const reloadButton = root.querySelector("[data-action='reload-schedule']");
        if (reloadButton) {
            reloadButton.hidden = !this._isDirty;
        }

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
                text.textContent = this._duplicateMessage(duplicates);
            }
        }
    }

    _formatMonthName(monthIndex) {
        return new Date(2026, monthIndex, 1).toLocaleString(undefined, {
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

    // Returns HH:MM:SS, or null when the value is not a time. It used to fall
    // back to 07:00:00 for anything it did not understand, which turned the
    // empty value a time field reports while it is being retyped into a stored
    // 07:00:00.
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

    // Times that appear more than once in the month, normalized so that 07:00
    // and 07:00:00 are recognised as the same time.
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

    // The integration keeps duplicates and counts each one as a watering slot of
    // its own, so two identical times double the daily target.
    _duplicateMessage(duplicates) {
        return `Duplicate times (${duplicates.join(", ")}) count twice towards the daily target.`;
    }

    _changeMonth(delta) {
        this.currentMonth = (this.currentMonth + delta + 12) % 12;
        this._copyConfirm = null;
        this._selectedCalendarDay = null;
        this._loadCalendarData();
        this.render();
    }

    _selectMonth(monthIndex) {
        this.currentMonth = Number(monthIndex);
        this._copyConfirm = null;
        this._loadCalendarData();
        this.render();
    }

    _updateIntervalDays(value, { commit = false } = {}) {
        const str = String(value ?? "").trim();

        // An empty field is a half-typed number, not a request for 0. Writing it
        // on every keystroke reset the interval whenever the box was cleared to
        // retype it. `commit` is true when the field is left (the change event):
        // redraw so the field shows what is stored.
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
        monthSchedule.interval_days = Math.max(0, parsed);
        this._markDirty();

        if (commit && monthSchedule.interval_days !== parsed) {
            this.render();
        }
    }

    _addTimeSlot() {
        const monthSchedule = this._ensureScheduleData();
        monthSchedule.hours.push("07:00:00");
        this._markDirty();
        this.render();
    }

    _updateTimeSlot(index, value, { commit = false } = {}) {
        const monthSchedule = this._ensureScheduleData();

        if (!Number.isInteger(index) || index < 0 || index >= monthSchedule.hours.length) {
            return;
        }

        const normalized = this._normalizeTimeForStorage(value);

        // A time input reports an empty value while it is being retyped. Keep
        // the last valid time and, once the field is left, show it again.
        if (!normalized) {
            if (commit) {
                this.render();
            }

            return;
        }

        monthSchedule.hours[index] = normalized;
        this._markDirty();
        this._patchNotices();
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

    _updateStationTime(stationKey, value, { commit = false } = {}) {
        const str = String(value ?? "").trim();

        // Same as the interval: an empty field is not a request for 0.
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
        monthSchedule.stations[stationKey] = Math.max(0, parsed);
        this._markDirty();

        if (commit && monthSchedule.stations[stationKey] !== parsed) {
            this.render();
        }
    }

    // "Copy this month" reuses the selected month in others, so a year does not
    // have to be filled in twelve times. It never writes anything on its own:
    // it asks first, says how many months already have times that it would
    // replace, and leaves the card unsaved so Save (or Reload) decides.
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
            "Not saved yet."
        );
    }

    _copyTargetIndexes(target) {
        const all = Array.from({ length: 12 }, (_, index) => index);

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

    // How many of the months a copy would replace already have times set.
    _copyReplacesCount(target) {
        return this._copyTargetIndexes(target).filter(
            (index) => this._getMonthSchedule(index).hours.length > 0
        ).length;
    }

    _setStatus(message, type = "info") {
        this._status = { message, type };

        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
        }

        this._statusTimer = setTimeout(() => {
            this._status = null;
            this._patchStatus();
        }, 3500);

        this._patchStatus();
    }

    // Update the status line in place. Every render() replaces the whole shadow
    // DOM, so redrawing for a status message - or for the timer that clears it a
    // few seconds later - took the focus away from the field being typed into.
    _patchStatus() {
        const node = this.shadowRoot?.querySelector("[data-role='status']");

        if (!node) {
            this.render();
            return;
        }

        node.className = `status ${this._status?.type || ""}`;
        node.textContent = this._status?.message || "";
    }

    async _saveSchedule() {
        if (!this._hass) {
            this._setStatus("Home Assistant is not ready yet.", "error");
            return;
        }

        if (!this._servicePrefix) {
            this._setStatus("Could not determine the schedule service for this controller.", "error");
            return;
        }

        // Never store a time the card cannot read. Replacing it with 07:00:00,
        // as this used to, would change the schedule behind the user's back;
        // saying so lets them fix it.
        const months = Array.isArray(this.scheduleData) ? this.scheduleData : [];

        for (let monthIndex = 0; monthIndex < months.length; monthIndex += 1) {
            const hours = Array.isArray(months[monthIndex]?.hours) ? months[monthIndex].hours : [];
            const invalid = hours.find((hour) => !this._normalizeTimeForStorage(hour));

            if (invalid !== undefined) {
                this._setStatus(
                    `${this._formatMonthName(monthIndex)} has a time that is not valid ` +
                    `("${invalid}"). Fix or remove it, then save again.`,
                    "error"
                );
                return;
            }
        }

        const scheduleArray = Array.isArray(this.scheduleData)
            ? this.scheduleData.map((monthSchedule) => ({
                hours: Array.isArray(monthSchedule?.hours)
                    ? monthSchedule.hours.map((hour) => this._normalizeTimeForStorage(hour))
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
            this._patchNotices();
            this._setStatus("Schedule saved successfully.", "success");
        } catch (error) {
            this._setStatus(
                error?.message || "Failed to save the schedule.",
                "error"
            );
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
                this._updateStationTime(stationKey, event.currentTarget.value, { commit: true });
            });
        });
    }

    // The schedule repeats every year, so a month on its own does not pin down
    // a calendar: the weekdays differ. "June" asked in October means next June,
    // and the year is printed in the heading so the choice is never implicit.
    _getDisplayYear(monthIndex = this.currentMonth) {
        const now = new Date();

        if (this._config?.calendar_history === true) {
            // Current month and the next three months are forecasts.
            // All other months represent the most recent occurrence in the past.
            const ahead = (monthIndex - now.getMonth() + 12) % 12;
            if (ahead <= 3) {
                return monthIndex < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
            }
            return monthIndex > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
        }
        return monthIndex >= now.getMonth() ? now.getFullYear() : now.getFullYear() + 1;
    }

    _getFirstWeekday() {
        return this._hass?.locale?.first_weekday === "sunday" ? 0 : 1;
    }


    _calendarSourceIds() {
        const stations = Array.isArray(this._config?.calendar_station_sensors)
            ? this._config.calendar_station_sensors.filter((id) => typeof id === "string" && id.startsWith("sensor."))
            : [];
        const rain = this._config?.calendar_rain_sensor;
        return [...new Set([...stations, ...(typeof rain === "string" && rain.startsWith("sensor.") ? [rain] : [])])];
    }

    _calendarKey(year, month) {
        return String(year) + "-" + String(month + 1).padStart(2, "0");
    }

    _loadCalendarData() {
        if (!this._hass || this._config?.calendar !== true) return;
        const enabledHistory = this._config?.calendar_history === true;
        const ids = this._calendarSourceIds();
        const today = new Date();
        const year = this._getDisplayYear();
        const month = this.currentMonth;
        const key = this._calendarKey(year, month);
        if (enabledHistory && ids.length && new Date(year, month, 1) <= today) {
            const historyKey = key + "|" + ids.join(",");
            if (this._historyKey !== historyKey) {
                this._historyKey = historyKey;
                this._historyByDay = null;
                const from = new Date(year, month, 1);
                const to = new Date(Math.min(new Date(year, month + 1, 1).getTime(),
                    new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()));
                if (from < to) {
                    this._readCalendarStatistics(ids, from, to, historyKey);
                } else {
                    this._historyByDay = {};
                }
            }
        }
        const weatherId = this._config?.calendar_weather;
        if (typeof weatherId === "string" && weatherId.startsWith("weather.")
            && typeof this._hass.connection?.subscribeMessage === "function") {
            if (this._forecastKey !== weatherId) {
                this._unsubscribeCalendarForecast();
                this._forecastKey = weatherId;
                this._dailyForecast = null;
                const requestKey = weatherId;
                this._hass.connection.subscribeMessage((event) => {
                    if (this._forecastKey !== requestKey) return;
                    this._dailyForecast = Array.isArray(event?.forecast) ? event.forecast : [];
                    this.render();
                }, { type: "weather/subscribe_forecast", entity_id: weatherId, forecast_type: "daily" })
                    .then((unsubscribe) => {
                        if (this._forecastKey === requestKey) this._unsubscribeForecast = unsubscribe;
                        else unsubscribe();
                    })
                    .catch(() => {
                        if (this._forecastKey === requestKey) this._dailyForecast = [];
                    });
            }
        } else if (this._forecastKey) {
            this._unsubscribeCalendarForecast();
        }
    }

    async _readCalendarStatistics(ids, from, to, requestKey) {
        let daily = {};
        let available = new Set();
        try {
            if (typeof this._hass.callWS !== "function") throw new Error("Statistics API unavailable");
            const result = await this._hass.callWS({
                type: "recorder/statistics_during_period",
                start_time: from.toISOString(),
                end_time: to.toISOString(),
                statistic_ids: ids,
                period: "hour",
                types: ["state"]
            });
            for (const id of ids) {
                const samples = result?.[id];
                if (!Array.isArray(samples) || !samples.some((item) => Number.isFinite(item.state))) continue;
                available.add(id);
                for (const item of samples) {
                    const value = item.state;
                    const end = new Date(item.end);
                    if (value === null || value === undefined || !Number.isFinite(Number(value))
                        || !Number.isFinite(end.getTime())) continue;
                    // Statistics contain the state at the END of each period.
                    // Group by the local day containing the end, less one millisecond.
                    const at = new Date(end.getTime() - 1);
                    const dayKey = this._calendarKey(at.getFullYear(), at.getMonth()) +
                        "-" + String(at.getDate()).padStart(2, "0");
                    daily[dayKey] ??= {};
                    daily[dayKey][id] = Number(value);
                }
            }
        } catch (_error) {
            // Recorder state history is the fallback when statistics are unavailable.
        }

        const missing = ids.filter((id) => !available.has(id));
        if (missing.length && typeof this._hass.callApi === "function") {
            try {
                const records = await this._hass.callApi("GET",
                    "history/period/" + encodeURIComponent(from.toISOString()) +
                    "?end_time=" + encodeURIComponent(to.toISOString()) +
                    "&filter_entity_id=" + encodeURIComponent(missing.join(",")));
                for (const series of Array.isArray(records) ? records : []) {
                    const id = series[0]?.entity_id;
                    if (!missing.includes(id)) continue;
                    for (const item of series) {
                        const at = new Date(item.last_changed || item.last_updated);
                        const value = Number(item.state);
                        if (!Number.isFinite(at.getTime()) || !Number.isFinite(value) ||
                            value < 0 || at < from || at >= to) continue;
                        const dayKey = this._calendarKey(at.getFullYear(), at.getMonth()) +
                            "-" + String(at.getDate()).padStart(2, "0");
                        daily[dayKey] ??= {};
                        const previous = daily[dayKey][id + "_time"] ?? -Infinity;
                        if (at.getTime() >= previous) {
                            daily[dayKey][id] = value;
                            daily[dayKey][id + "_time"] = at.getTime();
                        }
                    }
                }
            } catch (_error) {
                // Missing data stays unknown, never interpreted as zero.
            }
        }
        if (this._historyKey !== requestKey) return;
        this._historyByDay = daily;
        this.render();
    }

    _unsubscribeCalendarForecast() {
        if (typeof this._unsubscribeForecast === "function") {
            this._unsubscribeForecast();
            this._unsubscribeForecast = null;
        }
        this._forecastKey = null;
    }

    disconnectedCallback() {
        this._unsubscribeCalendarForecast();
    }

    _calendarObservations(year, month, day) {
        const dateKey = this._calendarKey(year, month) + "-" + String(day).padStart(2, "0");
        const amounts = { ...(this._historyByDay?.[dateKey] ?? {}) };
        const todayLocal = new Date();
        if (year === todayLocal.getFullYear() && month === todayLocal.getMonth()
            && day === todayLocal.getDate()) {
            for (const id of this._calendarSourceIds()) {
                const state = this._hass?.states?.[id]?.state;
                if (state !== null && state !== undefined && state !== "" &&
                    Number.isFinite(Number(state)) && Number(state) >= 0) {
                    amounts[id] = Number(state);
                }
            }
        }
        const rainValue = amounts[this._config?.calendar_rain_sensor];
        const rain = rainValue === undefined ? null : Number(rainValue);
        const configuredStations = Array.isArray(this._config?.calendar_station_sensors)
            ? this._config.calendar_station_sensors : [];
        const stations = configuredStations.map((id) =>
            amounts[id] === undefined ? null : Number(amounts[id]));
        const watered = stations.some((amount) => amount !== null && amount > 0);
        const today = new Date();
        const date = new Date(year, month, day);
        const past = date < new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const probabilityThreshold = Number(this._config?.calendar_rain_probability ?? 50);
        const daily = (this._dailyForecast ?? []).find((row) => {
            const at = new Date(row.datetime || row.datetime_iso || row.date);
            // Daily forecasts describe a local calendar date, not an instant.
            // Preserve its YYYY-MM-DD portion to avoid timezone shifts.
            const dateText = String(row.datetime || row.datetime_iso || row.date || "");
            const match = dateText.match(/^(\d{4})-(\d{2})-(\d{2})/);
            return match ? Number(match[1]) === year && Number(match[2]) === month + 1 && Number(match[3]) === day
                : !Number.isNaN(at.getTime()) && at.getFullYear() === year && at.getMonth() === month && at.getDate() === day;
        });
        const probability = Number(daily?.precipitation_probability);
        const forecastRain = !past && daily && Number.isFinite(probability)
            && probability >= (Number.isFinite(probabilityThreshold) ? probabilityThreshold : 50);
        return { rain, watered, stations, forecastRain, probability, past, known: Object.keys(amounts).some((id) => this._calendarSourceIds().includes(id)) };
    }

    _renderCalendarDayDetails(year, projection) {
        const day = this._selectedCalendarDay;
        const entry = projection.days.find((value) => value.day === day);
        if (!entry) return "";
        const observations = this._calendarObservations(year, this.currentMonth, day);
        const isHistorical = this._config?.calendar_history === true && (entry.isPast || entry.isToday);
        const parts = [];
        if (isHistorical) {
            parts.push('<div>Rainfall: ' + (observations.rain === null ? 'No data' : observations.rain.toFixed(2) + ' mm') + '</div>');
            observations.stations.forEach((amount, index) => {
                parts.push('<div>' + escapeText(this._getStationLabel("station_" + (index + 1) + "_minutes")) +
                    ': ' + (amount === null ? 'No data' : amount.toFixed(2) + ' mm') + '</div>');
            });
        } else {
            parts.push('<div>Rain forecast: ' + (observations.forecastRain
                ? observations.probability + '% probability'
                : 'No rain forecast above the configured threshold') + '</div>');
            if (entry.waters) {
                const month = this._getMonthSchedule();
                const stations = Object.entries(month.stations || {}).filter(([, duration]) => Number(duration) > 0);
                if (stations.length) {
                    const slots = (month.hours || []).filter(Boolean).length;
                    stations.forEach(([station, duration]) => {
                        parts.push('<div>' + escapeText(this._getStationLabel(station)) +
                            ': ' + (Number(duration) * slots) + ' minutes planned</div>');
                    });
                } else {
                    parts.push('<div>Irrigation scheduled</div>');
                }
            } else {
                parts.push('<div>No irrigation currently projected</div>');
            }
        }
        return '<div class="cal-day-details"><strong>' +
            escapeText(new Date(year, this.currentMonth, day).toLocaleDateString(
                this._hass?.locale?.language || undefined, { day: "numeric", month: "long", year: "numeric" })) +
            '</strong>' + parts.join("") + '</div>';
    }

    _renderCalendar(monthSchedule) {
        const year = this._getDisplayYear();
        const context = this._getIntervalContext();
        const hasTimes = (monthSchedule.hours ?? []).some(Boolean);
        // Times on a station with no minutes start nothing, so with every
        // station at 0 there is no day to mark, only the note to write.
        const canWater = Object.values(monthSchedule.stations ?? {})
            .some((value) => Number(value) > 0);
        const projection = projectWateringDays({
            year,
            monthIndex: this.currentMonth,
            hours: canWater ? monthSchedule.hours : [],
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

                if (entry.waters && !(this._config?.calendar_history === true && (entry.isPast || entry.isToday))) {
                    classes.push("waters");
                }
                if (this._selectedCalendarDay === entry.day) {
                    classes.push("selected");
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

                const observations = this._calendarObservations(year, this.currentMonth, entry.day);
                const showHistorical = this._config?.calendar_history === true && (entry.isPast || entry.isToday);
                const irrigationIcon = showHistorical ? observations.watered : (!entry.isPast && entry.waters);
                const rainIcon = showHistorical ? observations.rain !== null && observations.rain > 0 : observations.forecastRain;
                const labelParts = [String(entry.day)];
                if (showHistorical && observations.known) {
                    labelParts.push("Rain: " + (observations.rain === null ? "unknown" : observations.rain.toFixed(2) + " mm"));
                    observations.stations.forEach((amount, index) => {
                        labelParts.push(this._getStationLabel("station_" + (index + 1) + "_minutes") + ": " + (amount === null ? "unknown" : amount.toFixed(2) + " mm"));
                    });
                } else if (!entry.isPast) {
                    if (irrigationIcon) labelParts.push("Projected watering: " + projection.hours.join(", "));
                    if (rainIcon) labelParts.push("Rain probability: " + observations.probability + "%");
                }
                const label = labelParts.join(" | ");

                return `
                    <div class="${classes.join(" ")}" data-day="${entry.day}" role="button" tabindex="0" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
                        <span class="cal-day">${entry.day}</span>
                        ${(this._config?.calendar_history || this._config?.calendar_weather) ?
                            '<span class="cal-icons">' +
                                (rainIcon ? '<ha-icon icon="mdi:water" class="cal-rain"></ha-icon>' : '') +
                                (irrigationIcon ? '<ha-icon icon="mdi:sprinkler" class="cal-irrigation"></ha-icon>' : '') +
                            '</span>' :
                            (entry.waters ? '<span class="cal-dot"></span>' : '')}
                    </div>
                `;
            }),
        ].join("");

        const every = `every ${projection.intervalDays} ${projection.intervalDays === 1 ? "day" : "days"}`;
        let note;

        const monthIsPast = new Date(year, this.currentMonth + 1, 0) <
            new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        if (this._config?.calendar_history === true && monthIsPast) {
            note = "Historical rainfall and irrigation are based on recorded sensor values. Days without records are not treated as dry days.";
        } else if (!hasTimes) {
            note = "No times configured for this month, so no day waters.";
        } else if (!canWater) {
            note =
                "Times are set but every station is at 0 minutes, so these days " +
                "start nothing.";
        } else if (projection.mode === "projected") {
            const until = context.blockedUntil
                ? ` Watering is on hold until ${escapeText(context.blockedUntil)}.`
                : "";

            note =
                "Projected from the last rain or sprinkle, assuming the weather does " +
                "not change. Rain resets the interval, so these days can move, and a " +
                "rain forecast can still shorten or skip a watering shown here." + until;
        } else if (!context.available) {
            note =
                `Only the pattern of the rule - ${every} from the 1st. This ` +
                "controller does not publish the last rain and sprinkle (Smart Water " +
                "Controller 1.1.2 or newer does), so the real days cannot be projected.";
        } else {
            note =
                `Only the pattern of the rule - ${every} from the 1st. The real ` +
                "days depend on when it last rained, which is only known for the " +
                "current month.";
        }

        return `
            <section class="section">
                <h3 class="section-title">
                    Calendar ${escapeText(this._formatMonthName(this.currentMonth))} ${year}
                </h3>
                <p class="section-description cal-note">${note}</p>

                <div class="cal-grid" role="grid" aria-label="Watering days">
                    ${weekdays.map((name) => `
                        <div class="cal-weekday">${escapeText(name)}</div>
                    `).join("")}
                    ${cells}
                </div>

                ${this._selectedCalendarDay ? this._renderCalendarDayDetails(year, projection) : ""}
                <div class="cal-legend">
                    ${(this._config?.calendar_history || this._config?.calendar_weather)
                        ? '<span class="cal-legend-item"><ha-icon icon="mdi:water" class="cal-rain"></ha-icon>Rain</span><span class="cal-legend-item"><ha-icon icon="mdi:sprinkler" class="cal-irrigation"></ha-icon>Irrigation</span>'
                        : '<span class="cal-legend-item"><span class="cal-dot"></span>waters</span>'}
                    <span class="cal-legend-item"><span class="cal-swatch today"></span>Today</span>
                </div>
            </section>
        `;
    }

    render() {
        if (!this.shadowRoot) {
            return;
        }

        const entity = this._getEntity();
        const monthSchedule = this._getMonthSchedule();
        const monthName = this._formatMonthName(this.currentMonth);
        const stationEntries = this._getStationKeys(monthSchedule).map((stationKey) => [
            stationKey,
            monthSchedule.stations?.[stationKey] ?? 0,
        ]);
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
                .time-field:focus {
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
                .save-button {
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
                .save-button:active {
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
                .save-button ha-icon {
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

                .badge ha-icon {
                    width: 14px;
                    height: 14px;
                }

                .quiet-button {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    min-height: 32px;
                    padding: 0 12px;
                    border: 1px solid var(--divider-color);
                    border-radius: 999px;
                    background: transparent;
                    color: var(--secondary-text-color);
                    font: inherit;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                }

                .quiet-button[hidden] {
                    display: none;
                }

                .quiet-button:hover {
                    background: var(--secondary-background-color);
                }

                .quiet-button ha-icon {
                    display: block;
                    width: 18px;
                    height: 18px;
                    margin: 0;
                }

                .footer-actions {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .footer {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 12px;
                    margin-top: 18px;
                    flex-wrap: wrap;
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

                .compact-select:focus {
                    border-color: var(--primary-color);
                    box-shadow: 0 0 0 1px var(--primary-color);
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
                    border: 1px solid color-mix(in srgb, var(--primary-text-color) 22%, transparent);
                    font-size: 13px;
                    background: var(--secondary-background-color);
                    color: var(--primary-text-color);
                }

                .cal-cell.empty {
                    background: none;
                    border: none;
                }

                .cal-cell.past {
                    opacity: 0.7;
                }
                .cal-cell.past:has(.cal-icons ha-icon) {
                    opacity: 1;
                }

                .cal-cell.waters {
                    background: color-mix(in srgb, var(--primary-color) 18%, transparent);
                    font-weight: 500;
                }

                .cal-cell.selected {
                    background: color-mix(in srgb, var(--primary-text-color) 17%, var(--secondary-background-color));
                }
                .cal-cell.selected {
                    animation: selected-day-glow 2.8s ease-in-out infinite;
                }
                @keyframes selected-day-glow {
                    0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-text-color) 8%, transparent), 0 0 3px color-mix(in srgb, var(--primary-text-color) 8%, transparent); }
                    50% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-text-color) 24%, transparent), 0 0 12px 2px color-mix(in srgb, var(--primary-text-color) 20%, transparent); }
                }
                @media (prefers-reduced-motion: reduce) {
                    .cal-cell.selected { animation: none; box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-text-color) 22%, transparent); }
                }
                .cal-cell.today {
                    outline: 2px solid var(--primary-color);
                    outline-offset: -2px;
                }

                .cal-cell.blocked .cal-day {
                    text-decoration: line-through;
                }

                .cal-icons { display: flex; gap: 2px; align-items: center; justify-content: center; height: 18px; flex: 0 0 18px; margin-top: -6px; }
                .cal-icons ha-icon { --mdc-icon-size: 16px; --iron-icon-height: 16px; --iron-icon-width: 16px; display: block; width: 16px; height: 16px; flex: 0 0 16px; }
                .cal-rain { color: var(--info-color, #039be5); }
                .cal-irrigation { color: var(--success-color, #43a047); transform: translateY(-1px); }

                .cal-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: var(--primary-color);
                }

                .cal-day-details { padding: 10px 12px; margin-top: 12px; border-radius: 8px; background: var(--secondary-background-color); font-size: 12px; line-height: 1.7; }
                .cal-day-details strong { display: block; font-size: 13px; margin-bottom: 4px; }
                .cal-cell[data-day] { cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease; }
                .cal-cell[data-day]:active { border-color: var(--primary-color); }
                .cal-cell[data-day]:focus-visible { outline: 2px solid var(--primary-color); }
                .cal-legend ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; }
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

                    .footer {
                        align-items: stretch;
                    }

                    .copy-row {
                        grid-template-columns: 1fr;
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
                                ${Array.from({ length: 12 }, (_, index) => `
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
                        <span data-role="duplicate-text">${escapeText(this._duplicateMessage(duplicates))}</span>
                    </div>

                    ${this.scheduleData && this._config?.calendar === true
                        ? this._renderCalendar(monthSchedule)
                        : ""}

                    ${this.scheduleData ? `
                        <section class="section">
                            <h3 class="section-title">Interval between sprinkles</h3>
                            <p class="section-description">Number of days between watering cycles for ${escapeText(monthName)}.</p>
                            <input
                                class="field"
                                type="number"
                                min="0"
                                step="1"
                                inputmode="numeric"
                                value="${escapeAttribute(monthSchedule.interval_days)}"
                                data-role="interval-days"
                            >
                        </section>

                        <section class="section">
                            <h3 class="section-title">Scheduled times</h3>
                            <p class="section-description">Add one or more times for this month. Times are stored in 24-hour format.</p>

                            <div class="time-list">
                                ${monthSchedule.hours.map((hour, index) => `
                                    <div class="time-row">
                                        <input
                                            class="time-field"
                                            type="time"
                                            value="${escapeAttribute(this._normalizeTimeForInput(hour))}"
                                            data-role="time-slot"
                                            data-index="${index}"
                                        >
                                        <button
                                            class="danger-button"
                                            type="button"
                                            data-action="remove-time"
                                            data-index="${index}"
                                            aria-label="Remove time ${escapeAttribute(this._normalizeTimeForInput(hour))}"
                                        >
                                            <span class="button-icon danger-icon">
                                                <ha-icon icon="mdi:close"></ha-icon>
                                            </span>
                                        </button>
                                    </div>
                                `).join("")}
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
                            <p class="section-description">Set the watering duration in minutes for each station in ${escapeText(monthName)}.</p>

                            <div class="station-list">
                                ${stationEntries.length === 0 ? `
                                    <p class="empty-hint">No stations reported by the integration yet.</p>
                                ` : ""}
                                ${stationEntries.map(([stationKey, minutes]) => `
                                    <div class="station-row">
                                        <div class="station-label">${escapeText(this._getStationLabel(stationKey))}</div>
                                        <input
                                            class="field"
                                            type="number"
                                            min="0"
                                            step="1"
                                            inputmode="numeric"
                                            value="${escapeAttribute(minutes)}"
                                            data-role="station-minutes"
                                            data-station-key="${escapeAttribute(stationKey)}"
                                        >
                                    </div>
                                `).join("")}
                            </div>
                        </section>

                        ${this._config?.copy_month === true ? `
                            <section class="section">
                                <h3 class="section-title">Copy this month</h3>
                                <p class="section-description">Reuse the settings of ${escapeText(monthName)} in other months instead of filling in all twelve by hand. Nothing is saved until you press Save.</p>

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
                                            ${this._copyReplacesCount(this._copyConfirm) ? escapeText(
                                                this._copyReplacesCount(this._copyConfirm) === 1
                                                    ? "1 of them already has times."
                                                    : `${this._copyReplacesCount(this._copyConfirm)} of them already have times.`
                                            ) : ""}
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
                        ` : ""}
                    ` : `
                        <div class="placeholder">
                            ${entity ? "Loading schedule data..." : `Entity not found: ${escapeText(this.sensor)}`}
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
                                aria-label="Discard the edits and reload the schedule from Home Assistant"
                                ${this._isDirty ? "" : "hidden"}
                            >
                                <ha-icon icon="mdi:refresh"></ha-icon>
                                <span>Reload</span>
                            </button>
                            <button
                                class="save-button"
                                type="button"
                                data-action="save-schedule"
                                ${this.scheduleData ? "" : "disabled"}
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
    }
}

customElements.define("smart-water-controller-schedule-card", IrrigationScheduleCard);
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
    this._expandedControllers = new Set();
    this._timer = null;
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
    const ids = [...Object.values(this._config || {}), ...((this._config?.controllers || []).flatMap(item => Object.values(item))), ...((this._config?.water_sensors || []).map(item => item.entity))]
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
  irrigationSource(config) {
    // Prefer controller attributes; older integrations may expose the source on stations.
    const ids = [config.controller, ...(config.zone_statuses || [])];
    for (const id of ids) {
      const source = this.entity(id)?.attributes?.irrigation_source;
      if (typeof source === 'string' && source.trim()) return source.trim().toLowerCase();
    }
    return null;
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
    return { ...c, controller, connectionLost, active, available, station, source,
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
    this.draftDurations = {};
  }
  setConfig(config) {
    if (!Array.isArray(config.zones) || !config.zones.length) throw Error('zones is required');
    this.config = {
      duration: 'number.rainbird_irrigation_manual_duration',
      end_time: 'sensor.rainbird_irrigation_end_time',
      stop: 'button.rainbird_stop_sprinkle',
      show_global_stop: true,
      show_zone_stop_all: true,
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
        zone.duration, zone.end_time, zone.stop, zone.stop_station,
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
  stopAllId(zone) {
    // Multi-controller cards must never use another controller's global stop.
    const groups = new Set((this.config?.zones || []).map(item => this.zoneGroup(item)));
    const primaryGroup = this.zoneGroup(this.config?.zones?.[0]);
    return groups.size > 1 && this.zoneGroup(zone) !== primaryGroup && !zone.stop
      ? null : this.stopId(zone);
  }
  stopStationId(zone) {
    if (zone?.stop_station) return this.entity(zone.stop_station) ? zone.stop_station : null;
    // Existing dashboards can use new integration buttons without rewriting YAML
    // when start and station-stop entity IDs share the standard naming convention.
    const start = zone?.start;
    if (!start?.startsWith('button.') || !start.includes('_sprinkle_')) return null;
    const candidate = start.replace('_sprinkle_', '_stop_');
    return this.entity(candidate) ? candidate : null;
  }
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
  stopAll(zone) {
    const target = this.stopAllId(zone);
    if (target) this.press(target, `Stop ALL irrigation on ${this.zoneGroup(zone)}?`, zone);
  }
  stopStation(zone) {
    const target = this.stopStationId(zone);
    if (target) this.press(target, `Stop only ${zone.name} and continue to the next station?`, zone);
  }
  render() {
    if (!this.config || !this._hass) return;
    const active = this.active();
    const disconnected = this.connectionLost();
    const multiController = new Set(this.config.zones.map(zone => this.zoneGroup(zone))).size > 1;
    const rows = this.config.zones.map((zone,index) => {
      const running = this.running(zone), expanded = this.openZone === index, progress = this.progress(zone);
      const sourceLabel = running ? this.irrigationLabel(zone) : null;
      const stopAll = running && this.config.show_zone_stop_all ? this.stopAllId(zone) : null;
      const stopStation = running ? this.stopStationId(zone) : null;
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
        ${stopAll ? `<div class="zone-stop-row"><span>Stop the complete cycle</span><button class="zone-stop-all" data-stop-all="${index}" ${this.busy || disconnected ? 'disabled' : ''}><ha-icon icon="mdi:stop-circle-outline"></ha-icon>Stop All</button></div>` : ''}
        ${expanded ? `<div class="details">
          <div class="metrics">${this.metric('Status',zone.status)}${this.metric('Irrigated today',zone.today)}${this.metric('Scheduled today',zone.planned)}${this.metric('Remaining today',zone.remaining)}</div>
          ${progress === null ? '' : `<div class="progress-label"><span>Today's schedule</span><strong>${Math.round(progress)}%</strong></div><div class="progress"><div style="width:${progress}%"></div></div>`}
          <div class="controls"><div class="duration"><label>Manual duration</label><div class="stepper">
            <button data-step="-1" data-zone="${index}" ${this.busy || disconnected || duration === null || duration <= min ? 'disabled':''}><ha-icon icon="mdi:minus"></ha-icon></button>
            <button data-info="${this.esc(this.durationId(zone))}" class="duration-value">${duration ?? '—'} min</button>
            <button data-step="1" data-zone="${index}" ${this.busy || disconnected || duration === null || duration >= max ? 'disabled':''}><ha-icon icon="mdi:plus"></ha-icon></button>
          </div></div>${!running || stopStation ? `<button class="action ${running ? 'stop':'start'}" data-action="${index}" ${this.busy || disconnected || (!running && activeInGroup) ? 'disabled':''}><ha-icon icon="mdi:${running ? 'stop':'play'}"></ha-icon>${running ? 'Stop Station':'Start'}</button>` : ''}</div>
          ${zone.valve ? `<button class="valve" data-info="${this.esc(zone.valve)}"><ha-icon icon="mdi:valve"></ha-icon>Valve details<ha-icon icon="mdi:chevron-right"></ha-icon></button>` : ''}
        </div>` : ''}</section>`;
    }).join('');
    const globalStop = !this.config.show_zone_stop_all && !multiController && this.config.show_global_stop && active
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
      .zone-stop-row{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:0 4px 10px 55px}.zone-stop-row span{flex:1;color:var(--secondary-text-color);font-size:11px}.zone-stop-all{display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--red) 16%,transparent);color:var(--red);font-size:12px;font-weight:700}.zone-stop-all ha-icon{--mdc-icon-size:17px}
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
      if (this.running(zone)) this.stopStation(zone); else this.start(zone);
    }));
    this.shadowRoot.querySelectorAll('[data-stop-all]').forEach(el => el.addEventListener('click', () => {
      const zone = this.config.zones[Number(el.dataset.stopAll)];
      if (zone) this.stopAll(zone);
      else if (active) this.press(this.stopId(active), 'Stop all irrigation?', active);
    }));
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
