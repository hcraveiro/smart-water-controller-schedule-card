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

        if (this._hasActiveEditor()) {
            this._pendingEntitySync = true;
            return;
        }

        this._pendingEntitySync = false;
        this._syncFromEntity();
    }

    getCardSize() {
        return this._shouldShowHeader() ? 8 : 7;
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
        }

        if (!scheduleJson && force) {
            this.scheduleData = null;
            this._lastLoadedScheduleJson = null;
        }

        this.render();
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
        this._isDirty = true;
    }

    _formatMonthName(monthIndex) {
        return new Date(2026, monthIndex, 1).toLocaleString(undefined, {
            month: "long",
        });
    }

    _normalizeTimeForInput(value) {
        if (!value) {
            return "07:00";
        }

        const str = String(value);
        return str.length >= 5 ? str.slice(0, 5) : str;
    }

    _normalizeTimeForStorage(value) {
        if (!value) {
            return "07:00:00";
        }

        const str = String(value).trim();

        if (/^\d{2}:\d{2}:\d{2}$/.test(str)) {
            return str;
        }

        if (/^\d{2}:\d{2}$/.test(str)) {
            return `${str}:00`;
        }

        return "07:00:00";
    }

    _changeMonth(delta) {
        this.currentMonth = (this.currentMonth + delta + 12) % 12;
        this.render();
    }

    _selectMonth(monthIndex) {
        this.currentMonth = Number(monthIndex);
        this.render();
    }

    _updateIntervalDays(value) {
        const monthSchedule = this._ensureScheduleData();
        monthSchedule.interval_days = Math.max(0, parseInt(value, 10) || 0);
        this._markDirty();
    }

    _addTimeSlot() {
        const monthSchedule = this._ensureScheduleData();
        monthSchedule.hours.push("07:00:00");
        this._markDirty();
        this.render();
    }

    _updateTimeSlot(index, value) {
        const monthSchedule = this._ensureScheduleData();

        if (!monthSchedule.hours[index] && monthSchedule.hours[index] !== "") {
            return;
        }

        monthSchedule.hours[index] = this._normalizeTimeForStorage(value);
        this._markDirty();
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

    _updateStationTime(stationKey, value) {
        const monthSchedule = this._ensureScheduleData();
        monthSchedule.stations[stationKey] = Math.max(0, parseInt(value, 10) || 0);
        this._markDirty();
    }

    _setStatus(message, type = "info") {
        this._status = { message, type };

        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
        }

        this._statusTimer = setTimeout(() => {
            this._status = null;
            this.render();
        }, 3500);

        this.render();
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
            this._lastLoadedScheduleJson = JSON.stringify(scheduleArray);
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

        const intervalInput = root.querySelector("[data-role='interval-days']");
        intervalInput?.addEventListener("input", (event) => {
            this._updateIntervalDays(event.target.value);
        });
        intervalInput?.addEventListener("change", (event) => {
            this._updateIntervalDays(event.target.value);
        });

        root.querySelectorAll("[data-role='time-slot']").forEach((input) => {
            const updateHandler = (event) => {
                const index = Number(event.currentTarget.dataset.index);
                this._updateTimeSlot(index, event.currentTarget.value);
            };

            input.addEventListener("input", updateHandler);
            input.addEventListener("change", updateHandler);
        });

        root.querySelectorAll("[data-action='remove-time']").forEach((button) => {
            button.addEventListener("click", (event) => {
                const index = Number(event.currentTarget.dataset.index);
                this._removeTimeSlot(index);
            });
        });

        root.querySelectorAll("[data-role='station-minutes']").forEach((input) => {
            const updateHandler = (event) => {
                const stationKey = event.currentTarget.dataset.stationKey;
                this._updateStationTime(stationKey, event.currentTarget.value);
            };

            input.addEventListener("input", updateHandler);
            input.addEventListener("change", updateHandler);
        });
    }

    render() {
        if (!this.shadowRoot) {
            return;
        }

        const entity = this._getEntity();
        const monthSchedule = this._getMonthSchedule();
        const monthName = this._formatMonthName(this.currentMonth);
        const stationEntries = Object.entries(monthSchedule.stations || {}).sort((a, b) => {
            const aNum = parseInt(String(a[0]).replace(/\D/g, ""), 10) || 0;
            const bNum = parseInt(String(b[0]).replace(/\D/g, ""), 10) || 0;
            return aNum - bNum;
        });
        const showHeader = this._shouldShowHeader();
        const headerTitle = this._getHeaderTitle();

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

                .placeholder {
                    padding: 18px 0 6px;
                    color: var(--secondary-text-color);
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

                    .save-button {
                        width: 100%;
                        justify-content: center;
                    }
                }
            </style>

            <ha-card>
                <div class="wrapper">
                    ${showHeader ? `
                        <div class="card-header">
                            <div class="card-header-title">
                                <div class="name">${headerTitle}</div>
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
                                        ${this._formatMonthName(index)}
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

                    ${this.scheduleData ? `
                        <section class="section">
                            <h3 class="section-title">Interval between sprinkles</h3>
                            <p class="section-description">Number of days between watering cycles for ${monthName}.</p>
                            <input
                                class="field"
                                type="number"
                                min="0"
                                step="1"
                                inputmode="numeric"
                                value="${monthSchedule.interval_days}"
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
                                            value="${this._normalizeTimeForInput(hour)}"
                                            data-role="time-slot"
                                            data-index="${index}"
                                        >
                                        <button
                                            class="danger-button"
                                            type="button"
                                            data-action="remove-time"
                                            data-index="${index}"
                                            aria-label="Remove time ${this._normalizeTimeForInput(hour)}"
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
                            <p class="section-description">Set the watering duration in minutes for each station in ${monthName}.</p>

                            <div class="station-list">
                                ${stationEntries.map(([stationKey, minutes]) => `
                                    <div class="station-row">
                                        <div class="station-label">${this._getStationLabel(stationKey)}</div>
                                        <input
                                            class="field"
                                            type="number"
                                            min="0"
                                            step="1"
                                            inputmode="numeric"
                                            value="${minutes}"
                                            data-role="station-minutes"
                                            data-station-key="${stationKey}"
                                        >
                                    </div>
                                `).join("")}
                            </div>
                        </section>
                    ` : `
                        <div class="placeholder">
                            ${entity ? "Loading schedule data..." : `Entity not found: ${this.sensor}`}
                        </div>
                    `}

                    <div class="footer">
                        <div class="status ${this._status?.type || ""}">${this._status?.message || ""}</div>
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
            </ha-card>
        `;

        this._attachEventListeners();
    }
}

customElements.define("smart-water-controller-schedule-card", IrrigationScheduleCard);