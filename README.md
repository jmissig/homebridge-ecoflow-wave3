# homebridge-ecoflow-wave3

Bring an EcoFlow WAVE 3 portable air conditioner into Apple Home through
Homebridge.

This plugin is deliberately small and device-specific. It presents each
configured WAVE 3 as a standard HomeKit `HeaterCooler` accessory instead of
trying to support every EcoFlow product or expose every setting in the EcoFlow
app.

> [!WARNING]
> This is an unpublished, pre-release project. Core cloud state, power,
> temperature, and fan controls have been exercised against one real WAVE 3,
> but broader mode and long-session acceptance remain incomplete. Do not rely
> on it for unattended climate control.

> [!NOTE]
> The checked-in implementation still uses HAP `HeaterCooler`, but the accepted
> pre-release direction is a Matter-only replacement. The migration sequence is
> tracked in [`TODO.md`](TODO.md) and
> [Decision 0003](docs/decisions/0003-matter-only.md). There will not be a
> permanently supported dual HAP/Matter mode.

## What it provides

- Power control
- Current and target temperature
- Ambient humidity, alongside the ambient current-temperature reading
- Cooling, heating, and automatic modes
- Fan speed
- Device firmware revision in HomeKit accessory information
- One HomeKit accessory for each explicitly configured WAVE 3

The plugin uses EcoFlow's private, app-facing cloud service. It is not local
control, requires an internet connection, and may stop working if EcoFlow
changes that service. Dry mode, fan-only mode, drainage, battery information,
display settings, and other secondary features are intentionally not presented
as finished HomeKit features yet.

## Before you start

You will need:

- Homebridge 2
- Node.js 24 or newer
- An EcoFlow account with the WAVE 3 already added in the EcoFlow app
- The serial number of each WAVE 3 you want to add

The plugin signs in to EcoFlow using the email address and password stored in
your Homebridge configuration. Treat that configuration as sensitive.

## Getting started

The plugin is not published to npm yet, so the current setup is for developers
testing a checkout:

```sh
git clone https://github.com/jmissig/homebridge-ecoflow-wave3.git
cd homebridge-ecoflow-wave3
npm install
npm run verify
npm link
```

Add the **EcoFlow WAVE 3** platform in Homebridge UI and enter:

1. Your EcoFlow account email and password.
2. The EcoFlow API region used by your account.
3. A HomeKit display name and serial number for each WAVE 3.

If you edit `config.json` directly, the equivalent configuration is:

```json
{
  "platform": "EcoFlowWave3",
  "name": "EcoFlow WAVE 3",
  "email": "you@example.com",
  "password": "your-ecoflow-password",
  "apiHost": "api-a.ecoflow.com",
  "devices": [
    {
      "name": "Bedroom WAVE 3",
      "serialNumber": "YOUR_WAVE_3_SERIAL",
      "currentTemperatureSource": "ambient"
    }
  ]
}
```

`currentTemperatureSource` is optional per device and defaults to `ambient`:

- `ambient` — use the WAVE 3 ambient sensor and add its humidity sensor.
- `outlet` — use field 494, identified upstream as indoor supply-air
  temperature. This mapping is experimental pending one more Home app check.
- `none` — publish no Matter local-temperature or humidity measurement.

Available API regions are:

- `api.ecoflow.com` — Global
- `api-a.ecoflow.com` — Americas
- `api-e.ecoflow.com` — Europe

Run early tests in an isolated Homebridge child bridge. Matter accessory
registration and pairing are implemented in the following 0.2 migration phase;
this phase establishes the required bridge contract first.

The Matter-only 0.2 development line requires Matter on this child bridge and
does not fall back to HAP. Configure the EcoFlow platform's `_bridge` block as:

```json
"_bridge": {
  "username": "AA:BB:CC:DD:EE:FF",
  "port": 30141,
  "hap": { "enabled": false },
  "matter": {
    "enabled": true,
    "name": "EcoFlow WAVE 3"
  }
}
```

This setting affects only the EcoFlow child bridge. Other Homebridge bridges
and child bridges may continue using HAP.

## Debug logging

The plugin uses Homebridge's standard debug logging. When the plugin runs in a
child bridge, enable **Debug Mode** in that child bridge's settings to scope
verbose logging to the EcoFlow child process. The equivalent `config.json`
setting is `debugModeEnabled` in the same `_bridge` block; it is independent of
the `hap` and `matter` protocol settings:

```json
"_bridge": {
  "username": "AA:BB:CC:DD:EE:FF",
  "port": 30141,
  "debugModeEnabled": true
}
```

Homebridge passes `-D` only to that child bridge. MQTT routing, packet decode
summaries, controller state, refresh IDs, and command-coalescing diagnostics
then become visible without enabling debug output for the main bridge or other
child bridges. No plugin-specific debug configuration property is needed.

Normal logging remains intentionally concise. EcoFlow account authentication
attempts and outcomes, the MQTT-ready milestone, connection warnings, and all
errors remain visible without debug logging. Credentials, account identifiers,
serial numbers, full MQTT topics, and raw payload bytes remain redacted in both
normal and debug logs.

## Developing

```sh
npm run verify
```

That command checks generated protocol code, linting, types, tests, and a clean
build. It uses synthetic fixtures and does not contact EcoFlow, an MQTT broker,
Homebridge, or a real WAVE 3.

Protocol details and implementation evidence live in
[`docs/protocol.md`](docs/protocol.md). Third-party attribution is in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

Original work is licensed under the [BSD 3-Clause License](LICENSE).
Protocol-derived files retain their Apache 2.0 licensing and attribution; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

Made with Codex and OpenClaw.
