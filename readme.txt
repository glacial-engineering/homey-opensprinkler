Control OpenSprinkler from Homey Flows over MQTT. Stop all watering, start a program, enable or disable programs, run a single station, set a rain delay, and toggle controller operation — all as Flow action cards.

The app also listens to OpenSprinkler's MQTT status messages, exposing triggers for program starts, station on/off changes, sensor changes, weather (watering level) updates, and flow alerts, plus conditions for whether the controller is enabled and whether any station is running.

Configure your MQTT broker, OpenSprinkler's publish and command topics, and your device password in app settings. Firmware 2.2.1+ uses separate publish and command topics, so set both to match your controller, and enable the events you want under the controller's Notifications options. The device password is MD5-hashed before use and never sent in plain text.

This app was coded almost entirely with AI assistance and reviewed lightly. The architectural guidance was provided by a developer with more than 30 years of experience.
