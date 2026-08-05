# Contributing

Thanks for helping improve the EcoFlow WAVE 3 Homebridge plugin.

## Before opening a pull request

1. Use Node.js 24 and install dependencies with `npm ci`.
2. Keep changes focused on the WAVE 3 and the plugin's Matter-only design.
3. Add or update deterministic tests for behavior changes.
4. Run `npm run verify`.
5. Update user-facing documentation when configuration or behavior changes.

Routine development and verification must not require a real EcoFlow account,
the production EcoFlow MQTT broker, a live Homebridge installation, or physical
hardware. Use synthetic or anonymized fixtures and fakes at external
boundaries.

Never commit or paste account credentials, bearer tokens, MQTT credentials,
full device serial numbers, private MQTT topics, raw payloads, packet captures,
or real Homebridge configuration. Sanitize logs before sharing them.

Protocol-derived changes must preserve the attribution and licensing described
in `THIRD_PARTY_NOTICES.md`.
