class CustomDropdown {
    constructor(element) {
        this.element = element;
        this.selectedElement = element.querySelector('.dropdown-selected');
        this.optionsElement = element.querySelector('.dropdown-options');
        this.options = Array.from(this.optionsElement.querySelectorAll('.dropdown-option'));

        // Adicionando evento de clique para abrir/fechar o dropdown
        this.selectedElement.addEventListener('click', () => {
            this.toggleDropdown();
        });

        // Adicionando evento de clique nas opções para selecionar o mês
        this.options.forEach(option => {
            option.addEventListener('click', () => {
                this.selectOption(option);
            });
        });
    }

    // Função para abrir e fechar o dropdown
    toggleDropdown() {
        this.element.classList.toggle('open');
    }

    // Função para selecionar a opção e atualizar o mês
    selectOption(option) {
        const value = option.getAttribute('data-value');
        this.selectedElement.querySelector('span').textContent = option.textContent;
        this.toggleDropdown();  // Fecha o dropdown
        this.currentMonth = parseInt(value);  // Atualiza o mês
        
        // Emitir o evento personalizado com o mês selecionado
        const event = new CustomEvent('monthChanged', {
            detail: {
                month: this.currentMonth
            },
            bubbles: true,  // Faz com que o evento se propague para elementos pais
            composed: true  // Permite que o evento atravesse o Shadow DOM (se estiver usando)
        });
        this.element.dispatchEvent(event);  // Dispara o evento no componente
    }
}

class IrrigationScheduleCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this.currentMonth = new Date().getMonth();
        this.scheduleData = null; // Estado local
        this._hass = null;
    }

    connectedCallback() {
        // Ouvir o evento 'monthChanged' emitido pelo CustomDropdown
        this.addEventListener('monthChanged', this.changeMonthFromDropdown);
    }

    disconnectedCallback() {
        // Remover o ouvinte de eventos quando o componente for desconectado
        this.removeEventListener('monthChanged', this.changeMonthFromDropdown);
    }

    setConfig(config) {
        if (!config.sensor) {
            throw new Error("You need to define a sensor in config.");
        }
        this.sensor = config.sensor;
        
        this.mac_address = this.extractMacAddress(this.sensor); // Extrai o MAC Address

        if (!this.mac_address) {
            console.error("Not possible to extract MAC Address from the sensor:", this.sensor);
            return;
        }
    
        if (this._hass && !this.scheduleData) {
            this.fetchSensorData();
        } else {
            this.addEventListener('hass-connected', () => this.fetchSensorData());
        }
    }

   extractMacAddress(entity_id) {
        // Assume que o nome da entidade tem o formato: sensor.mac_address_qualquer_coisa
        const match = entity_id.match(/^sensor\.([0-9a-fA-F]{2}_[0-9a-fA-F]{2}_[0-9a-fA-F]{2}_[0-9a-fA-F]{2}_[0-9a-fA-F]{2}_[0-9a-fA-F]{2})_/);
        return match ? match[1] : null; // Retorna o MAC Address se encontrado
    }
    
    set hass(hass) {
        this._hass = hass;
    
        // Chama fetchSensorData apenas se os dados não foram carregados
        if (!this.scheduleData) {
            this.fetchSensorData();
        }
    }

    async fetchSensorData() {
        if (!this._hass || this.scheduleData) return; // Will only execute if data is loaded
    
        const entity = this._hass.states[this.sensor];
        if (entity && entity.attributes && entity.attributes.schedule) {
            const fullSchedule = entity.attributes.schedule;  // Dados de todos os meses
            if (fullSchedule) {
                // Se os dados do calendário não foram carregados, armazena todos os meses
                if (!this.scheduleData) {
                    this.scheduleData = JSON.parse(JSON.stringify(fullSchedule)); // Cópia local dos dados de todos os meses
                }
            }
        }
        this.render();
    }

    handleMonthChange() {
        const card = this.shadowRoot.querySelector('.card');
        
        // Esconde o mês atual
        card.classList.add('hidden');
        
        // Espera a animação de fade-out terminar
        setTimeout(() => {
            this.render(); // Re-renderiza com o novo mês
            
            // Garante que o novo mês inicie escondido
            const newCard = this.shadowRoot.querySelector('.card');
            newCard.classList.add('hidden');
            
            // Aplica o fade-in no novo mês
            setTimeout(() => {
                newCard.classList.remove('hidden');
            }, 25); // Pequeno delay para evitar flicker
        }, 200); // Tempo do fade-out
    }
    
    changeMonth(delta) {
        this.currentMonth = (this.currentMonth + delta + 12) % 12; // Troca o mês
        this.handleMonthChange(); // Reaproveita o código para a transição
    }

    changeMonthFromDropdown(event) {
        this.currentMonth = event.detail.month;
        this.handleMonthChange(); // Reaproveita o código para a transição
    }

    updateIntervalDays(event) {
        const monthSchedule = this.scheduleData[this.currentMonth] || { hours: [], stations: {}, interval_days: 0 };
    
        this.scheduleData = {
            ...this.scheduleData,
            [this.currentMonth]: {
                ...monthSchedule,
                interval_days: parseInt(event.target.value) || 0
            }
        };
        this.render();
    }

    addTimeSlot() {
        const monthSchedule = this.scheduleData[this.currentMonth] || { hours: [], stations: {}, interval_days: 0 };
    
        if (!monthSchedule) {
            this.scheduleData[this.currentMonth] = { hours: [], stations: {}, interval_days: 0 };
        }
    
        if (!this.scheduleData[this.currentMonth].hours) {
            this.scheduleData[this.currentMonth].hours = [];
        }
    
        this.scheduleData[this.currentMonth].hours.push("07:00:00");
        this.render();
    }

    updateTimeSlot(index, event) {
        const monthSchedule = this.scheduleData[this.currentMonth] || { hours: [], stations: {}, interval_days: 0 };
        if (monthSchedule && monthSchedule.hours) {
            monthSchedule.hours[index] = event.target.value;
            this.render();
        }
    }
    
    removeTimeSlot(index) {
        const monthSchedule = this.scheduleData[this.currentMonth] || { hours: [], stations: {}, interval_days: 0 };
        if (monthSchedule && monthSchedule.hours && monthSchedule.hours.length > index) {
            monthSchedule.hours.splice(index, 1);
            this.render();
        }
    }

    updateStationTime(stationKey, event) {
        const monthSchedule = this.scheduleData[this.currentMonth] || { hours: [], stations: {}, interval_days: 0 };
    
        this.scheduleData = {
            ...this.scheduleData,
            [this.currentMonth]: {
                ...monthSchedule,
                stations: {
                    ...monthSchedule.stations,
                    [stationKey]: parseInt(event.target.value) || 0
                }
            }
        };
        this.render();
    }

    saveSchedule() {
        const scheduleArray = Object.keys(this.scheduleData)
                .sort((a, b) => a - b) // Ordena as chaves numericamente
                .map(month => this.scheduleData[month]); // Converte o objeto num array de objetos
        
        const serviceName = `set_irrigation_schedule_${this.mac_address}`;

        // Chama o serviço sem esperar pela resposta
        this._hass.callService("smart_water_controller", serviceName, { 
            schedule: scheduleArray 
        });
    
        // Adiciona a notificação visual
        this.showSaveNotification();
    }
    
    showSaveNotification() {
        const notification = document.createElement("div");
        notification.textContent = "Schedule saved successfully!";
        notification.style.position = "fixed";
        notification.style.top = "20px";
        notification.style.left = "50%";
        notification.style.transform = "translateX(-50%)";
        notification.style.backgroundColor = "#28a745"; // Cor verde (para sucesso)
        notification.style.color = "#fff";
        notification.style.padding = "10px 20px";
        notification.style.borderRadius = "5px";
        notification.style.fontSize = "1em";
        notification.style.boxShadow = "0 4px 6px rgba(0, 0, 0, 0.2)";
        notification.style.zIndex = "1000";
        document.body.appendChild(notification);
    
        // Remove a notificação após 3 segundos
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }
    
    findAllElementsRecursively(root, selector) {
        let elements = [];
    
        if (!root) return elements;
    
        // Se o root tem shadowRoot, busca dentro dele primeiro
        if (root.shadowRoot) {
            elements.push(...this.findAllElementsRecursively(root.shadowRoot, selector));
        }
    
        // Buscar diretamente dentro do root caso seja um Document ou ShadowRoot
        if (root instanceof Document || root instanceof ShadowRoot) {
            elements.push(...root.querySelectorAll(selector));
        }
    
        // Iterar por todos os filhos do root e buscar recursivamente
        root.childNodes.forEach(child => {
            elements.push(...this.findAllElementsRecursively(child, selector));
        });
    
        return elements;
    }

    render() {
        if (!this.shadowRoot || !this.scheduleData) return;

        const monthSchedule = this.scheduleData[this.currentMonth] || { hours: [], stations: {}, interval_days: 0 };

        this.shadowRoot.innerHTML = `
            <style>
                @keyframes fadeInOut {
                    0% {
                        opacity: 0;
                        visibility: hidden;
                    }
                    50% {
                        opacity: 1;
                        visibility: visible;
                    }
                    100% {
                        opacity: 0;
                        visibility: hidden;
                    }
                }
                .card-transition {
                    animation: fadeInOut 1s ease-in-out forwards;
                }
                /* Estilo do card */
                .card {
                    background-color: white;
                    padding: 20px;
                    border-radius: 12px;
                    box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1); /* Sombra suave */
                    transition: box-shadow 0.3s ease; /* Somente a sombra irá transitar */
                }
                
                /* Efeito de hover sem movimentação */
                .card:hover {
                    box-shadow: 0px 6px 16px rgba(0, 0, 0, 0.15); /* A sombra aumenta ao passar o mouse */
                }
                
                /* Efeito de foco no card */
                .card:focus {
                    outline: none;
                    border: 2px solid #007BFF; /* Foco azul */
                }
                .card.hidden {
                    opacity: 0;
                }
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 1.2em;
                    font-weight: bold;
                }
                .month-selector button {
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                }
                .month-selector select {
                    font-size: 1em;
                    padding: 5px;
                    border-radius: 5px;
                }
                .schedule-list {
                    margin-top: 10px;
                }
                .section {
                    margin-top: 10px;
                    padding: 10px;
                    border-radius: 5px;
                    background: #ffffff;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                    padding: 10px;
                }
                .section h3 {
                    margin: 0;
                    font-size: 1.1em;
                    font-weight: bold;
                    color: #0073e6;
                    border-bottom: 2px solid #0073e6;
                    padding-bottom: 5px;
                    margin-bottom: 8px;
                }
                .section input {
                    width: 100%;
                    padding: 5px;
                    margin-top: 5px;
                    font-size: 1em;
                }
                .buttons {
                    display: flex;
                    justify-content: space-between;
                    margin-top: 10px;
                }
                .btn {
                    background-color: #0073e6;
                    color: white;
                    border: none;
                    padding: 10px;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 1em;
                }
                .btn-danger {
                    background-color: #e60000;
                }
                .section div {
                    display: flex;
                    align-items: center;
                    margin-bottom: 8px;
                }
                .section div span {
                    margin-right: 10px; /* Espaço entre a label e o input */
                    white-space: nowrap; /* Impede que o texto da label quebre para a linha seguinte */
                }
                .section div input {
                    flex-grow: 1;
                    margin-right: 10px; /* Espaço entre o input e o botão */
                }
                .section div button {
                    margin-left: 10px; /* Espaço à esquerda do botão */
                }
            
                /* Estilos específicos para os ícones de emojis */
                .btn i, .btn span, .btn-danger i, .btn-danger span {
                    color: transparent !important; /* Tornar a cor do emoji transparente */
                    text-shadow: 0 0 0 white !important; /* Aplicar o texto em branco via sombra */
                    font-size: inherit; /* Garantir que o tamanho do emoji seja o mesmo do botão */
                }
                /* Estilo do dropdown */
                .custom-dropdown {
                    position: relative;
                    width: 200px;
                    font-size: 14px;
                    border-radius: 6px;
                    background-color: #007BFF;
                    color: white;
                    cursor: pointer;
                }
                
                /* Estilo do item selecionado */
                .dropdown-selected {
                    padding: 6px 10px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
            
                /* Estilo da seta */
                .dropdown-arrow {
                    font-size: 14px;
                }
                
                /* Estilo da lista de opções */
                .dropdown-options {
                    display: none; /* Esconde as opções por padrão */
                    position: absolute;
                    background-color: #007BFF;
                    min-width: 160px;
                    box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.2);
                    z-index: 1;
                }
                
                /* Exibe as opções quando o dropdown estiver aberto */
                .dropdown.open .dropdown-options {
                    display: block;
                }
            
                /* Estilo de cada opção dentro do dropdown */
                .dropdown-option {
                    padding: 6px 10px;
                    cursor: pointer;
                }
            
                /* Hover para opções */
                .dropdown-option:hover {
                    background-color: #004085;
                }
                /* Efeito de hover do dropdown */
                .custom-dropdown:hover .dropdown-options {
                    display: block;
                }
            </style>

            <ha-card class="card">
                <div class="header">
                    <button class="prev">⬅</button>
                    <div class="custom-dropdown">
                        <div class="dropdown-selected">
                            <span>${new Date(2025, this.currentMonth, 1).toLocaleString('default', { month: 'long' })}</span>
                            <div class="dropdown-arrow">▼</div>
                        </div>
                        <div class="dropdown-options">
                            ${[...Array(12).keys()].map(i => `
                                <div class="dropdown-option" data-value="${i}">
                                    ${new Date(2025, i, 1).toLocaleString('default', { month: 'long' })}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <button class="next">➡</button>
                </div>
                <div class="schedule-list">
                    <div class="section">
                        <h3>Interval between sprinkles (days)</h3>
                        <input type="number" value="${monthSchedule.interval_days}" 
                            oninput="this.getRootNode().host.updateIntervalDays(event)">
                    </div>
                    <div class="section">
                        <h3>Scheduled times</h3>
                        ${monthSchedule.hours.map((hour, index) => ` 
                            <div>
                                <input type="time" value="${hour}" 
                                    oninput="this.getRootNode().host.updateTimeSlot(${index}, event)">
                                <button class="btn btn-danger" onclick="this.getRootNode().host.removeTimeSlot(${index})"><span>❌</span></button>
                            </div>
                        `).join("")}
                        <button class="btn btn-add-time" onclick="this.getRootNode().host.addTimeSlot()"><span>➕</span> Add Time</button>
                    </div>
                    <div class="section">
                        <h3>Sprinkle time per station (minutes)</h3>
                        ${Object.entries(monthSchedule.stations).map(([station, minutes]) => ` 
                            <div>
                                <span>${station.replace("_minutes", "").replace("station_", "Station ")}</span>
                                <input type="number" value="${minutes}" 
                                    oninput="this.getRootNode().host.updateStationTime('${station}', event)">
                            </div>
                        `).join("")}
                    </div>
                </div>
                <div class="buttons">
                    <button class="btn" onclick="this.getRootNode().host.saveSchedule()">💾 Save</button>
                </div>
            </ha-card>
        `;
        
        const prevButton = this.shadowRoot.querySelector(".prev");
        const nextButton = this.shadowRoot.querySelector(".next");
        
        prevButton.replaceWith(prevButton.cloneNode(true));
        nextButton.replaceWith(nextButton.cloneNode(true));
        
        //this.shadowRoot.querySelector('.month-selector').addEventListener('change', (event) => this.updateMonthFromDropdown(event));
        this.shadowRoot.querySelector(".prev").addEventListener("click", () => this.changeMonth(-1));
        this.shadowRoot.querySelector(".next").addEventListener("click", () => this.changeMonth(1));
        
        // Buscar todos os cartões recursivamente
        const root = document.querySelector('home-assistant');

        let cards = [];
        setTimeout(() => {
            cards = this.findAllElementsRecursively(root, 'smart-water-controller-schedule-card');
            cards.forEach(card => {
                if (card.shadowRoot) {
                    const dropdown = card.shadowRoot.querySelector('.custom-dropdown');
            
                    if (dropdown) {
                        new CustomDropdown(dropdown);
                    }
                }
            });
        }, 100);

        
        // Capturar cliques para abrir o dropdown correto
        document.addEventListener("click", (event) => {
            const path = event.composedPath(); // Caminho do evento, incluindo shadow DOMs
            const card = path.find(el => el.tagName?.toLowerCase() === "smart-water-controller-schedule-card");
        
            if (card && card.shadowRoot) {
                // Encontrar o dropdown dentro do shadowRoot do card
                const dropdown = card.shadowRoot.querySelector('.custom-dropdown');
        
                if (dropdown) {
                    dropdown.click(); // Simula um clique para abrir o dropdown
                }
            }
        });
    }
}

customElements.define("smart-water-controller-schedule-card", IrrigationScheduleCard);
