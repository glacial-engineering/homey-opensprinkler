# OpenSprinkler for Homey

Athom Homey app that controls [OpenSprinkler](https://opensprinkler.com/) irrigation controllers and triggers Homey Flows from their MQTT messages. It talks to OpenSprinkler entirely over MQTT — no direct HTTP connection to the controller is needed, only a shared MQTT broker.

## How it works

OpenSprinkler (firmware 2.2.1+) publishes status events to an MQTT broker and can also **accept commands** over MQTT, formatted like its HTTP/JSON API (e.g. `cv?pw=<md5>&rsn=1`). Commands and status use **two separate topics**. This app:

- **publishes commands** to the controller's **command topic** (OpenSprinkler's `subt`, e.g. `opensprinkler/in`), with your device password MD5-hashed automatically, and
- **subscribes** to the status subtopics under the **publish topic** (`<pubt>/station/#`, `<pubt>/program/#`, `<pubt>/sensor1`, `<pubt>/weather`, …) to drive Flow triggers and conditions.

## Features

- MQTT connection configured from app settings (protocol, host, port, client ID, optional broker auth)
- Separate publish and command topics to match OpenSprinkler firmware 2.2.1+
- Device password is MD5-hashed in the app and never sent or logged in plain text
- **Action** cards: stop all watering, start a program, enable/disable a program, enable/disable controller operation, run a single station, set rain delay
- **Condition** cards: controller operation enabled/disabled, any/no station running
- **Trigger** cards: program started, station on/off, sensor changed, weather (watering level) changed, flow alert

## Setup

1. On OpenSprinkler: **Edit Options → MQTT**, enable MQTT and point it at your broker. Note the **publish topic** (`pubt`, often `opensprinkler` or MAC-based like `OS-112233AABBCC`) and the **command topic** (`subt`, commonly `<pubt>/in`).
2. On OpenSprinkler: **Edit Options → Notifications**, enable the events you want published (station on/off, program, sensors, weather, flow alert). If nothing is enabled the controller only publishes availability, and no triggers will fire.
3. Install this app on your Homey Pro.
4. Open the app's **Settings** and fill in:
   - MQTT broker host/port, and optional broker username/password
   - **Publish topic** — OpenSprinkler's `pubt`
   - **Command topic** — OpenSprinkler's `subt` (leave blank to use `<publish topic>/in`)
   - **Device password** — your OpenSprinkler web password (default `opendoor`)

## Flow cards

### Actions

| Card | Command |
| --- | --- |
| Stop all watering | `cv?rsn=1` |
| Start a program | `mp?pid=…&uwt=…` |
| Enable or disable a program | `cp?pid=…&en=…` |
| Enable or disable controller operation | `cv?en=…` |
| Run a single station for N seconds | `cm?sid=…&t=…&en=1` |
| Set rain delay (hours) | `cv?rd=…` |

### Conditions

- Controller operation is enabled / disabled
- Any / no station is running

### Triggers

- A program started
- A station turned on or off
- A sensor changed (sensor 1 / 2, active / inactive)
- Weather adjustment (watering level) changed
- Flow alert

Condition state (controller enabled, running stations) is tracked from published MQTT messages, so it reflects what the controller has most recently reported.

## Troubleshooting

- **Commands do nothing.** Check the **command topic** matches OpenSprinkler's `subt` exactly, and that the **device password** is correct — an incorrect password makes the controller silently reject every command.
- **No triggers fire.** Enable the relevant events under **Edit Options → Notifications** on the controller, and confirm the **publish topic** matches `pubt`.

## Notes

The device password is MD5-hashed inside the app before being published and is never transmitted or logged in plain text. Command logs redact the `pw` parameter.

This app was coded almost entirely with AI assistance and reviewed lightly. Architectural guidance was provided by a developer with 30+ years of experience.

## References

- [OpenSprinkler MQTT documentation](https://openthings.freshdesk.com/support/solutions/articles/5000859089-how-to-use-mqtt)
- [OpenSprinkler HTTP/JSON API (2.2.1)](https://opensprinkler.github.io/OpenSprinkler-Firmware/2.2.1/221_4_api/)
