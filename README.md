# homebridge-ecoflow-wave3

A focused Homebridge plugin for controlling the EcoFlow WAVE 3 through HomeKit.

## Status

The first cloud-backed plugin slice is implemented and passes its local
build, lint, and protocol tests. It has not yet been validated against a real
WAVE 3, so it should be treated as pre-release software.

Implemented HomeKit services:

- A primary `HeaterCooler` with power, cool/heat/auto mode, current
  temperature, temperature thresholds, and five-step fan speed
- A companion fan service for fan-only operation
- Ambient humidity
- Add-on battery level and charging state

The plugin uses EcoFlow's private app API and MQTT broker. Fully local MQTT or
Bluetooth control remains a possible later investigation.

## Install from source

Until the plugin is published, install it from this checkout:

```sh
git clone https://github.com/jmissig/homebridge-ecoflow-wave3.git
cd homebridge-ecoflow-wave3
npm install
npm run verify
npm link
```

Then link it into the Node installation used by Homebridge, or use
Homebridge UI's development/plugin installation workflow. Run it in a child
bridge while the hardware support is being validated.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "EcoFlowWave3",
      "name": "Guest Bedroom WAVE 3",
      "email": "ecoflow-account@example.com",
      "password": "your-ecoflow-password",
      "serialNumber": "YOUR-WAVE-3-SERIAL",
      "apiHost": "api.ecoflow.com"
    }
  ]
}
```

The account must already have the WAVE 3 paired in the official EcoFlow app.
Credentials are sent only to the configured EcoFlow API host, but Homebridge
stores plugin configuration as plain JSON; protect the Homebridge host and its
backups accordingly.

## What we know

- EcoFlow's official control paths are the WAVE 3's physical control panel and
  the EcoFlow app over Bluetooth or Wi-Fi.
- The WAVE 3 does not expose a conventional infrared remote-control interface.
- The community Home Assistant EcoFlow Cloud integration has working WAVE 3
  support using EcoFlow's private app API, `/app/...` MQTT topics, and binary
  Protocol Buffers messages.
- That integration has identified state and commands for power, operating mode,
  target temperature, fan speed, ambient and internal temperatures, condensate
  level, drainage mode, display and beeper settings, Pet Care, and related
  telemetry.
- This route depends on EcoFlow's login service and cloud MQTT broker. It is not
  local control and may break if EcoFlow changes its private protocol.

## Why a dedicated plugin

The existing
[`homebridge-ecoflow`](https://github.com/PietroLubini/homebridge-ecoflow)
project is useful prior art and has extensive tests, but its established
protocol path uses EcoFlow's public developer API, `/open/...` MQTT topics, and
JSON messages. Its dormant WAVE support targets an earlier product and was not
validated against hardware.

Working WAVE 3 support requires a substantially separate private-API
authentication, MQTT-topic, and protobuf stack. A small WAVE-3-specific plugin
can keep that boundary explicit and avoid carrying unrelated device support.

## Architecture

1. **`EcoFlowPrivateClient`** — login, token handling, temporary MQTT
   credentials, connection lifecycle, and `/app/...` topics.
2. **`Wave3Protocol`** — typed protobuf encoding and decoding, with fixtures
   derived from observed device messages.
3. **`Wave3Controller`** — normalized state, command acknowledgements,
   validation, and reconnect/state-refresh behavior.
4. **`Wave3Accessory`** — HomeKit presentation as a `HeaterCooler`, with
   carefully chosen companion services where HomeKit lacks a natural
   characteristic.

The first HomeKit surface includes:

- Active/inactive state
- Current and target temperature
- Cooling, heating, and automatic operation
- Current operating state
- Fan speed
- Ambient humidity and battery state

Secondary settings such as automatic drainage, beeper, display brightness, and
Pet Care—and fault or condensate-level indication—should not distort the
primary climate accessory. They can be added as optional companion services
after the core behavior is reliable.

## Development approach

- Run development builds in a Homebridge child bridge so failures are isolated.
- Capture anonymized fixtures and test protocol parsing without requiring live
  hardware for every test.
- Validate every command against a real WAVE 3 before treating support as
  complete.
- Keep credentials and device serial numbers out of fixtures, logs, and the
  repository.
- Treat local MQTT redirection or Bluetooth control as a separate experiment
  after cloud-backed control is stable.

## Upstream research

The main protocol reference is
[`tolwi/hassio-ecoflow-cloud`](https://github.com/tolwi/hassio-ecoflow-cloud),
particularly its WAVE 3 implementation and `wave3.proto`. The repository is
licensed under Apache License 2.0.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and
licensing details.

## License

Original code and documentation in this repository are licensed under the
BSD 3-Clause License; see [LICENSE](LICENSE).

Files copied from or substantially adapted from Apache-2.0 sources retain their
Apache-2.0 licensing and attribution. The Apache License text is included at
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt). Such files should carry an
`SPDX-License-Identifier: Apache-2.0` header and a prominent modification
notice where required.
