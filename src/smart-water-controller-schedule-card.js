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
        this.render();
    }

    _selectMonth(monthIndex) {
        this.currentMonth = Number(monthIndex);
        this._copyConfirm = null;
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

        return monthIndex >= now.getMonth() ? now.getFullYear() : now.getFullYear() + 1;
    }

    _getFirstWeekday() {
        return this._hass?.locale?.first_weekday === "sunday" ? 0 : 1;
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

        const every = `every ${projection.intervalDays} ${projection.intervalDays === 1 ? "day" : "days"}`;
        let note;

        if (!hasTimes) {
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