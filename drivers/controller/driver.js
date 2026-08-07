'use strict';

const Homey = require('homey');

class ControllerDriver extends Homey.Driver {
  async onInit() {
    this.registerFlowCards();
  }

  registerFlowCards() {
    // Actions — each reads args.device and delegates to the device instance.
    this.homey.flow.getActionCard('stop_all')
      .registerRunListener(async (args) => args.device.stopAll());

    this.homey.flow.getActionCard('start_program')
      .registerRunListener(async (args) => args.device.startProgram(args.pid, args.uwt));

    this.homey.flow.getActionCard('set_program_enabled')
      .registerRunListener(async (args) => args.device.setProgramEnabled(args.pid, args.en));

    this.homey.flow.getActionCard('set_controller_enabled')
      .registerRunListener(async (args) => args.device.setControllerEnabled(args.en));

    this.homey.flow.getActionCard('run_station')
      .registerRunListener(async (args) => args.device.runStation(args.sid, args.seconds));

    this.homey.flow.getActionCard('set_rain_delay')
      .registerRunListener(async (args) => args.device.setRainDelay(args.hours));

    this.homey.flow.getActionCard('pause_stations')
      .registerRunListener(async (args) => args.device.pauseStations(args.seconds));

    this.homey.flow.getActionCard('unpause_stations')
      .registerRunListener(async (args) => args.device.unpauseStations());

    // Conditions.
    this.homey.flow.getConditionCard('controller_enabled')
      .registerRunListener(async (args) => args.device.isControllerEnabled());

    this.homey.flow.getConditionCard('any_station_running')
      .registerRunListener(async (args) => args.device.isAnyStationRunning());

    // Triggers — device-scoped cards. run listeners filter by the args the
    // device passes into card.trigger(device, tokens, state).
    this.programStartedTrigger = this.homey.flow.getDeviceTriggerCard('program_started');
    this.programStartedTrigger.registerRunListener(async (args, state) => this.matchesText(args.pid, state.pid));

    this.stationChangedTrigger = this.homey.flow.getDeviceTriggerCard('station_changed');
    this.stationChangedTrigger.registerRunListener(async (args, state) => {
      const stateMatches = !args.state || args.state === 'any'
        || (args.state === 'on' && state.on)
        || (args.state === 'off' && !state.on);
      return this.matchesText(args.sid, state.sid) && stateMatches;
    });

    this.sensorChangedTrigger = this.homey.flow.getDeviceTriggerCard('sensor_changed');
    this.sensorChangedTrigger.registerRunListener(async (args, state) => {
      const sensorMatches = !args.sensor || args.sensor === 'any' || String(args.sensor) === String(state.sensor);
      const stateMatches = !args.state || args.state === 'any'
        || (args.state === 'active' && state.active)
        || (args.state === 'inactive' && !state.active);
      return sensorMatches && stateMatches;
    });

    this.weatherUpdatedTrigger = this.homey.flow.getDeviceTriggerCard('weather_updated');
    this.flowAlertTrigger = this.homey.flow.getDeviceTriggerCard('flow_alert');
  }

  matchesText(filterValue, actualValue) {
    if (filterValue === undefined || filterValue === null || filterValue === '') return true;
    return String(actualValue).toLowerCase() === String(filterValue).toLowerCase();
  }

  async onPair(session) {
    session.setHandler('add_controller', async (data) => {
      const publishTopic = (data.publishTopic || '').trim().replace(/^\/+|\/+$/g, '');
      const commandTopic = (data.commandTopic || '').trim().replace(/^\/+|\/+$/g, '');
      const devicePassword = data.devicePassword || '';

      if (!publishTopic) throw new Error('Publish topic is required.');

      return {
        name: data.name && data.name.trim() ? data.name.trim() : `OpenSprinkler (${publishTopic})`,
        data: {
          id: `opensprinkler-${publishTopic}`,
        },
        settings: {
          publishTopic,
          commandTopic,
          devicePassword,
        },
      };
    });
  }
}

module.exports = ControllerDriver;
