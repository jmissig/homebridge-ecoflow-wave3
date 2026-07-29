# homebridge-ecoflow-wave3

Bring an EcoFlow WAVE 3 portable air conditioner into Apple Home through
Homebridge.

This plugin is deliberately small and device-specific. It presents each
configured WAVE 3 as a standard HomeKit `HeaterCooler` accessory instead of
trying to support every EcoFlow product or expose every setting in the EcoFlow
app.

> [!WARNING]
> This is an unpublished, pre-release project. Its cloud connection and
> HomeKit behavior are covered by automated tests, but control has not yet been
> validated against a real WAVE 3. Do not rely on it for unattended climate
> control.

## What it provides

- Power control
- Current and target temperature
- Cooling, heating, and automatic modes
- Fan speed
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
      "serialNumber": "YOUR_WAVE_3_SERIAL"
    }
  ]
}
```

Available API regions are:

- `api.ecoflow.com` — Global
- `api-a.ecoflow.com` — Americas
- `api-e.ecoflow.com` — Europe

Run early tests in an isolated Homebridge child bridge. After Homebridge
restarts, the configured unit should appear as a heater/cooler accessory in
Apple Home.

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
