'use strict';

const Homey = require('homey');
const mqtt = require('mqtt');

class OpenSprinklerApp extends Homey.App {
  async onInit() {
    // Controller devices register themselves here so the app can dispatch
    // incoming MQTT messages to the device that owns the matching topic.
    this.devices = new Set();

    this.connectMqtt();

    this.homey.settings.on('set', (key) => {
      if (this.isMqttSetting(key)) this.reconnectMqtt();
    });
  }

  // --- Device registry -----------------------------------------------------

  registerDevice(device) {
    this.devices.add(device);
    this.resubscribe();
  }

  unregisterDevice(device) {
    this.devices.delete(device);
    this.resubscribe();
  }

  // --- MQTT connection -----------------------------------------------------

  connectMqtt() {
    const settings = this.getMqttSettings();

    if (!settings.host) {
      this.log('MQTT host is not configured; connection skipped.');
      return;
    }

    const url = `${settings.protocol}://${settings.host}:${settings.port}`;
    const options = {
      clientId: settings.clientId,
      username: settings.username || undefined,
      password: settings.password || undefined,
      clean: true,
      reconnectPeriod: 10000,
    };

    this.log(`Connecting to MQTT broker ${url}`);
    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      this.log('Connected to MQTT broker.');
      this.resubscribe();
      for (const device of this.devices) device.onBrokerConnected();
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

  get connected() {
    return !!(this.mqttClient && this.mqttClient.connected);
  }

  // Subscribe to each device's publish prefix. Called whenever the device set
  // or the connection changes; MQTT subscribe is idempotent per topic filter.
  resubscribe() {
    if (!this.connected) return;

    const filters = new Set();
    for (const device of this.devices) {
      const prefix = device.getPublishTopic();
      if (prefix) filters.add(`${prefix}/#`);
    }

    if (filters.size === 0) return;

    this.mqttClient.subscribe([...filters], (err) => {
      if (err) this.error('Subscribe failed:', err);
      else this.log(`Subscribed to ${[...filters].join(', ')}`);
    });
  }

  onMqttMessage(topic, message) {
    const raw = message.toString().trim();
    for (const device of this.devices) {
      if (device.ownsTopic(topic)) {
        device.handleMessage(topic, raw);
        return;
      }
    }
  }

  // Publish a command string to a controller's command topic. Called by devices.
  async publish(topic, message) {
    if (!this.connected) {
      throw new Error('Not connected to the MQTT broker. Check the app settings.');
    }
    return new Promise((resolve, reject) => {
      this.mqttClient.publish(topic, message, (err) => (err ? reject(err) : resolve()));
    });
  }

  // --- Settings ------------------------------------------------------------

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
      password: this.homey.settings.get('mqttPassword') || '',
    };
  }

  isMqttSetting(key) {
    return [
      'mqttProtocol',
      'mqttHost',
      'mqttPort',
      'mqttClientId',
      'mqttUsername',
      'mqttPassword',
    ].includes(key);
  }
}

module.exports = OpenSprinklerApp;
