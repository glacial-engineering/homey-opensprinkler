'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

class ControllerDevice extends Homey.Device {
  async onInit() {
    // Locally tracked state, kept current from published MQTT messages so
    // condition cards and capabilities reflect the controller without an HTTP
    // round-trip. Running stations are held as a Set of station-id strings.
    this.controllerEnabled = true;
    this.runningStations = new Set();

    this.registerCapabilityListener('onoff', async (value) => {
      // on = start the first program; off = stop all watering.
      if (value) return this.startProgram(0, 1);
      return this.stopAll();
    });

    this.homey.app.registerDevice(this);
    this.updateAvailability();
  }

  async onUninit() {
    this.homey.app.unregisterDevice(this);
  }

  async onSettings({ changedKeys }) {
    // Topic changes require the app to resubscribe to the new prefix.
    if (changedKeys.includes('publishTopic')) {
      this.homey.app.registerDevice(this);
    }
  }

  onBrokerConnected() {
    this.updateAvailability();
  }

  updateAvailability() {
    if (this.homey.app.connected) this.setAvailable().catch(this.error);
    else this.setUnavailable('MQTT broker not connected').catch(this.error);
  }

  // --- Topic helpers -------------------------------------------------------

  getPublishTopic() {
    return (this.getSetting('publishTopic') || '').replace(/^\/+|\/+$/g, '');
  }

  getCommandTopic() {
    const configured = (this.getSetting('commandTopic') || '').replace(/^\/+|\/+$/g, '');
    return configured || `${this.getPublishTopic()}/in`;
  }

  ownsTopic(topic) {
    const prefix = this.getPublishTopic();
    return !!prefix && (topic === prefix || topic.startsWith(`${prefix}/`));
  }

  getPasswordHash() {
    const password = this.getSetting('devicePassword') || '';
    return crypto.createHash('md5').update(password).digest('hex');
  }

  getBaseUrl() {
    return (this.getSetting('baseUrl') || '').replace(/\/+$/, '');
  }

  // --- Commands ------------------------------------------------------------

  // OpenSprinkler accepts commands on its command topic as HTTP-API-style
  // strings, e.g. "cv?pw=<md5>&rsn=1". The password must be an MD5 hash.
  async sendCommand(endpoint, params) {
    const query = { pw: this.getPasswordHash(), ...params };
    const queryString = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');

    const topic = this.getCommandTopic();
    const message = `${endpoint}?${queryString}`;

    this.log(`Command → ${topic}: ${message.replace(/pw=[^&]*/, 'pw=***')}`);
    return this.homey.app.publish(topic, message);
  }

  // Same query-string format as sendCommand, but sent as an HTTP GET directly
  // to the controller, for commands OpenSprinkler doesn't support over MQTT.
  async sendHttpCommand(endpoint, params) {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      throw new Error('Controller URL is not configured in device settings.');
    }

    const query = { pw: this.getPasswordHash(), ...params };
    const queryString = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');

    const url = `${baseUrl}/${endpoint}?${queryString}`;
    this.log(`HTTP Command → ${url.replace(/pw=[^&]*/, 'pw=***')}`);

    const client = url.startsWith('https:') ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.get(url, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Request timed out')));
    });
  }

  stopAll() {
    return this.sendCommand('cv', { rsn: 1 });
  }

  startProgram(pid, uwt) {
    return this.sendCommand('mp', { pid, uwt });
  }

  // OpenSprinkler's firmware does not dispatch "cp" over MQTT (only cv/cm/cr/mp
  // are recognized there), so this one command has to go over the HTTP API.
  setProgramEnabled(pid, en) {
    return this.sendHttpCommand('cp', { pid, en });
  }

  setControllerEnabled(en) {
    return this.sendCommand('cv', { en });
  }

  runStation(sid, seconds) {
    return this.sendCommand('cm', { sid, t: seconds, en: 1 });
  }

  setRainDelay(hours) {
    return this.sendCommand('cv', { rd: hours });
  }

  // --- Condition helpers ---------------------------------------------------

  isControllerEnabled() {
    return this.controllerEnabled;
  }

  isAnyStationRunning() {
    return this.runningStations.size > 0;
  }

  // --- Incoming messages ---------------------------------------------------

  handleMessage(topic, raw) {
    const prefix = this.getPublishTopic();

    // Ignore our own commands echoed back on the command topic (which often
    // nests under the publish prefix, e.g. "opensprinkler/in").
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
        this.error(`Failed to parse payload for ${topic}: ${err.message}`);
        return;
      }
    }

    this.routeMessage(subTopic, payload || {}, raw);
  }

  routeMessage(subTopic, payload, raw) {
    const stationMatch = subTopic.match(/^station\/(\d+)$/);
    if (stationMatch) return this.handleStation(stationMatch[1], payload, raw);

    const programMatch = subTopic.match(/^program\/(.+)$/);
    if (programMatch) return this.handleProgram(programMatch[1], payload, raw);

    if (subTopic === 'sensor1') return this.handleSensor('1', payload);
    if (subTopic === 'sensor2') return this.handleSensor('2', payload);

    if (subTopic === 'weather') {
      const level = this.numberOrDefault(payload['water level'] ?? payload.water_level, null);
      if (level !== null) {
        this.driver.weatherUpdatedTrigger.trigger(this, { water_level: level }).catch((err) => this.error(err));
      }
      return undefined;
    }

    if (subTopic === 'alert/flow') {
      this.driver.flowAlertTrigger.trigger(this, { raw_json: raw }).catch((err) => this.error(err));
    }

    return undefined;
  }

  handleStation(sid, payload, raw) {
    const on = this.numberOrDefault(payload.state, 0) === 1;

    if (on) this.runningStations.add(sid);
    else this.runningStations.delete(sid);

    if (this.hasCapability('alarm_water')) {
      this.setCapabilityValue('alarm_water', this.runningStations.size > 0).catch(this.error);
    }

    this.driver.stationChangedTrigger.trigger(this, {
      sid,
      on,
      duration: this.numberOrDefault(payload.duration, 0),
      raw_json: raw,
    }, { sid, on }).catch((err) => this.error(err));
  }

  handleProgram(pid, payload, raw) {
    // Skipped programs publish {"state":"skipped",...}; only fire for an
    // actual start ({"state":1}).
    if (this.numberOrDefault(payload.state, 0) !== 1) return;

    this.driver.programStartedTrigger.trigger(this, {
      pid,
      water_level: this.numberOrDefault(payload.wl, 0),
      raw_json: raw,
    }, { pid }).catch((err) => this.error(err));
  }

  handleSensor(sensor, payload) {
    const active = this.numberOrDefault(payload.state, 0) === 1;
    this.driver.sensorChangedTrigger.trigger(this, { sensor, active }, { sensor, active })
      .catch((err) => this.error(err));
  }

  numberOrDefault(value, defaultValue) {
    const number = Number(value);
    return Number.isFinite(number) ? number : defaultValue;
  }
}

module.exports = ControllerDevice;
