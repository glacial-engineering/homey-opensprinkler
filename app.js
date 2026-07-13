const Homey = require('homey');
const mqtt = require('mqtt');
const crypto = require('crypto');

const DEFAULT_TOPIC_PREFIX = 'opensprinkler';

class OpenSprinklerApp extends Homey.App {
  async onInit() {
    // Locally tracked state, kept up to date from published MQTT messages so
    // condition cards can answer without an HTTP round-trip. Stations that are
    // currently on are held in a Set keyed by station id (as a string).
    this.controllerEnabled = true;
    this.runningStations = new Set();

    this.triggers = {
      programStarted: this.homey.flow.getTriggerCard('program_started'),
      stationChanged: this.homey.flow.getTriggerCard('station_changed'),
      sensorChanged: this.homey.flow.getTriggerCard('sensor_changed'),
      weatherUpdated: this.homey.flow.getTriggerCard('weather_updated'),
      flowAlert: this.homey.flow.getTriggerCard('flow_alert'),
    };

    this.registerTriggerListeners();
    this.registerConditionListeners();
    this.registerActionListeners();
    this.connectMqtt();

    this.homey.settings.on('set', (key) => {
      if (this.isMqttSetting(key)) this.reconnectMqtt();
    });
  }

  registerTriggerListeners() {
    this.triggers.programStarted.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.pid, state.pid);
    });

    this.triggers.stationChanged.registerRunListener(async (args, state) => {
      const stateMatches = !args.state || args.state === 'any'
        || (args.state === 'on' && state.on)
        || (args.state === 'off' && !state.on);
      return this.matchesTextFilter(args.sid, state.sid) && stateMatches;
    });

    this.triggers.sensorChanged.registerRunListener(async (args, state) => {
      const sensorMatches = !args.sensor || args.sensor === 'any'
        || String(args.sensor) === String(state.sensor);
      const stateMatches = !args.state || args.state === 'any'
        || (args.state === 'active' && state.active)
        || (args.state === 'inactive' && !state.active);
      return sensorMatches && stateMatches;
    });
  }

  registerConditionListeners() {
    this.homey.flow.getConditionCard('controller_enabled')
      .registerRunListener(async () => this.controllerEnabled);

    this.homey.flow.getConditionCard('any_station_running')
      .registerRunListener(async () => this.runningStations.size > 0);
  }

  registerActionListeners() {
    this.homey.flow.getActionCard('stop_all')
      .registerRunListener(async () => this.sendCommand('cv', { rsn: 1 }));

    this.homey.flow.getActionCard('start_program')
      .registerRunListener(async (args) => this.sendCommand('mp', { pid: args.pid, uwt: args.uwt }));

    this.homey.flow.getActionCard('set_program_enabled')
      .registerRunListener(async (args) => this.sendCommand('cp', { pid: args.pid, en: args.en }));

    this.homey.flow.getActionCard('set_controller_enabled')
      .registerRunListener(async (args) => this.sendCommand('cv', { en: args.en }));

    this.homey.flow.getActionCard('run_station')
      .registerRunListener(async (args) => this.sendCommand('cm', { sid: args.sid, t: args.seconds, en: 1 }));

    this.homey.flow.getActionCard('set_rain_delay')
      .registerRunListener(async (args) => this.sendCommand('cv', { rd: args.hours }));
  }

  // OpenSprinkler accepts commands on its base MQTT topic as HTTP-API-style
  // strings, e.g. "cv?pw=<md5>&rsn=1". The password must be an MD5 hash.
  async sendCommand(endpoint, params) {
    if (!this.mqttClient || !this.mqttClient.connected) {
      throw new Error('Not connected to the MQTT broker. Check the app settings.');
    }

    const query = { pw: this.getPasswordHash(), ...params };
    const queryString = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');

    const topic = this.getCommandTopic();
    const message = `${endpoint}?${queryString}`;

    this.log(`Publishing command to ${topic}: ${endpoint}?${queryString.replace(/pw=[^&]*/, 'pw=***')}`);

    return new Promise((resolve, reject) => {
      this.mqttClient.publish(topic, message, (err) => (err ? reject(err) : resolve()));
    });
  }

  connectMqtt() {
    const settings = this.getMqttSettings();

    if (!settings.host) {
      this.log('MQTT host is not configured; OpenSprinkler MQTT connection skipped.');
      return;
    }

    const url = `${settings.protocol}://${settings.host}:${settings.port}`;
    const options = {
      clientId: settings.clientId,
      username: settings.username || undefined,
      password: settings.brokerPassword || undefined,
      clean: true,
      reconnectPeriod: 10000,
    };

    this.log(`Connecting to MQTT broker ${url}`);
    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      this.log('Connected to MQTT broker.');
      this.subscribeTopics();
    });

    this.mqttClient.on('message', (topic, message) => this.onMqttMessage(topic, message));
    this.mqttClient.on('error', (err) => this.error(err));
    this.mqttClient.on('close', () => this.log('MQTT connection closed.'));
  }

  reconnectMqtt() {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }

    this.connectMqtt();
  }

  subscribeTopics() {
    const prefix = this.getTopicPrefix();
    const topic = `${prefix}/#`;

    this.mqttClient.subscribe(topic, (err) => {
      if (err) {
        this.error(err);
        return;
      }

      this.log(`Subscribed to ${topic}`);
    });
  }

  onMqttMessage(topic, message) {
    const prefix = this.getTopicPrefix();
    const raw = message.toString().trim();

    // The command topic often nests under the publish prefix (e.g.
    // "sprinkle/in"), so our own published commands come back on the `<prefix>/#`
    // subscription. Ignore them — and the bare prefix topic — so they are never
    // parsed as status events.
    if (topic === this.getCommandTopic()) return;

    const subTopic = topic === prefix ? '' : topic.slice(prefix.length + 1);
    if (!subTopic) return;

    if (subTopic === 'availability') {
      this.log(`Availability: ${raw}`);
      return;
    }

    let payload = null;
    if (raw.startsWith('{')) {
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        this.error(`Failed to parse MQTT payload for ${topic}: ${err.message}`);
        return;
      }
    }

    this.routeMessage(subTopic, payload || {}, raw);
  }

  routeMessage(subTopic, payload, raw) {
    // station/<sid>
    const stationMatch = subTopic.match(/^station\/(\d+)$/);
    if (stationMatch) {
      this.handleStation(stationMatch[1], payload, raw);
      return;
    }

    // program/<pid>
    const programMatch = subTopic.match(/^program\/(.+)$/);
    if (programMatch) {
      this.handleProgram(programMatch[1], payload, raw);
      return;
    }

    if (subTopic === 'sensor1') {
      this.handleSensor('1', payload);
      return;
    }
    if (subTopic === 'sensor2') {
      this.handleSensor('2', payload);
      return;
    }

    if (subTopic === 'weather') {
      const level = this.numberOrDefault(payload['water level'] ?? payload.water_level, null);
      if (level !== null) {
        this.triggers.weatherUpdated.trigger({ water_level: level }).catch((err) => this.error(err));
      }
      return;
    }

    if (subTopic === 'alert/flow') {
      this.triggers.flowAlert.trigger({ raw_json: raw }).catch((err) => this.error(err));
    }
  }

  handleStation(sid, payload, raw) {
    const on = this.numberOrDefault(payload.state, 0) === 1;

    if (on) this.runningStations.add(sid);
    else this.runningStations.delete(sid);

    this.triggers.stationChanged.trigger({
      sid,
      on,
      duration: this.numberOrDefault(payload.duration, 0),
      raw_json: raw,
    }, { sid, on }).catch((err) => this.error(err));
  }

  handleProgram(pid, payload, raw) {
    // Skipped programs publish {"state":"skipped",...}; only fire the started
    // trigger for an actual start ({"state":1}).
    if (this.numberOrDefault(payload.state, 0) !== 1) return;

    this.triggers.programStarted.trigger({
      pid,
      water_level: this.numberOrDefault(payload.wl, 0),
      raw_json: raw,
    }, { pid }).catch((err) => this.error(err));
  }

  handleSensor(sensor, payload) {
    const active = this.numberOrDefault(payload.state, 0) === 1;
    this.triggers.sensorChanged.trigger({ sensor, active }, { sensor, active })
      .catch((err) => this.error(err));
  }

  getPasswordHash() {
    const password = this.homey.settings.get('devicePassword') || '';
    return crypto.createHash('md5').update(password).digest('hex');
  }

  getMqttSettings() {
    const protocol = this.homey.settings.get('mqttProtocol') || 'mqtt';
    const host = this.homey.settings.get('mqttHost') || '';
    const defaultPort = protocol === 'mqtts' ? 8883 : 1883;

    return {
      protocol,
      host,
      port: this.homey.settings.get('mqttPort') || defaultPort,
      clientId: this.homey.settings.get('mqttClientId') || `homey-opensprinkler-${Math.random().toString(16).slice(2)}`,
      username: this.homey.settings.get('mqttUsername') || '',
      brokerPassword: this.homey.settings.get('mqttPassword') || '',
    };
  }

  // The publish (status) topic — OpenSprinkler's "pubt". Status/availability
  // messages arrive under this prefix, and the app subscribes to `<prefix>/#`.
  getTopicPrefix() {
    return (this.homey.settings.get('topicPrefix') || DEFAULT_TOPIC_PREFIX).replace(/^\/+|\/+$/g, '');
  }

  // The command (subscribe) topic — OpenSprinkler's "subt", the topic the
  // controller listens on for commands. On firmware 2.2.1+ this is a separate
  // setting from the publish topic (commonly "<pubt>/in"). If left blank we
  // fall back to "<publish topic>/in".
  getCommandTopic() {
    const configured = (this.homey.settings.get('commandTopic') || '').replace(/^\/+|\/+$/g, '');
    return configured || `${this.getTopicPrefix()}/in`;
  }

  isMqttSetting(key) {
    return [
      'mqttProtocol',
      'mqttHost',
      'mqttPort',
      'mqttClientId',
      'mqttUsername',
      'mqttPassword',
      'topicPrefix',
      'commandTopic',
    ].includes(key);
  }

  matchesTextFilter(filterValue, actualValue) {
    if (filterValue === undefined || filterValue === null || filterValue === '') return true;
    return String(actualValue).toLowerCase() === String(filterValue).toLowerCase();
  }

  numberOrDefault(value, defaultValue) {
    const number = Number(value);
    return Number.isFinite(number) ? number : defaultValue;
  }
}

module.exports = OpenSprinklerApp;
