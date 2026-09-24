# Current

Ship a reliable, Matter-only Homebridge plugin for the EcoFlow WAVE 3 on
Homebridge 2.2.1 and newer 2.x releases.

The protocol boundary, command confirmation, coordinator, Matter presentation,
and primary Apple Home control paths are implemented. Household acceptance has
passed for Off→Cool, Off→Heat, Cool→Heat→Cool profile restoration, all five fan
speeds, and rapid-slider coalescing.
[told: Julian · 2026-08-08](https://discord.com/channels/1499872194610598249/1531866537185640448/1535769081100247090)

Auto remains decoded internally but is not advertised because Apple Home writes
Cool when Auto is selected on a Room Air Conditioner. Keep the integrated Room
Air Conditioner and revisit Auto only after that controller mapping changes.

## Now — finish resilience acceptance

- [ ] Validate Seasonal Storage in Apple Home: Off without persistent tile or
  summary errors, unknown rather than stale/zero readings, transient-only
  errors on blocked controls, unchanged pairing/room/scenes, read-only wake,
  and manual exit plus subsequent offline fault reporting. See
  [decision 0007](docs/decisions/0007-seasonal-storage.md).

- [ ] Verify concurrent EcoFlow app and Matter control without stale replay.
- [ ] Verify MQTT reconnect, child-bridge restart, WAVE power cycle, and an
  extended unattended freshness window.
- [ ] Verify startup with recent cache versus missing/expired cache and exactly
  one explicit refresh.
- [ ] Confirm normal and debug logs remain useful while credentials,
  identifiers, and raw payloads stay redacted.

## Release issue — same-UUID Matter shape replacement

The schema-5→6 Auto removal exposed a remaining Homebridge lifecycle failure.
Homebridge rejected the cached Auto-capable endpoint during restoration, its
public accessory API later reported that UUID absent, but the private Matter
topology retained the endpoint. Registering the schema-6 replacement therefore
created a second endpoint. A clean reset/recommission restored one schema-6
accessory on one endpoint.

- [ ] Reproduce the failed-restore/private-topology mismatch with the installed
  Homebridge runtime and determine whether the plugin can detect or prevent it.
- [ ] If no safe plugin-side recovery exists, document the least-destructive
  Apple Home and Homebridge recovery path. Try removing the stale accessory in
  Apple Home before removing or resetting the whole bridge.
- [ ] Document the reproducible commissioning handoff in which Apple Home first
  places the bridge and air conditioner in the selected room, temporarily moves
  both to Default Room as No Response, then recovers and allows reassignment.

Source: household Homebridge diagnostics and Apple Home commissioning
observations · 2026-08-08

## Release readiness

- [ ] Complete the resilience acceptance and same-UUID migration disposition
  above.
- [ ] Run `npm run verify` and inspect `npm pack --dry-run` for the release
  candidate.
- [ ] Review the configuration schema, install/update instructions,
  troubleshooting, privacy language, and supported-controller caveats.
- [ ] Prepare versioning, release notes, changelog, and npm metadata.
- [ ] Keep the package private until Julian explicitly approves publication.

## Watch — deferred interoperability

- [ ] Decode or safely diagnose the official EcoFlow app's Auto range-write
  acknowledgement fields. Accepted app writes did not change the subsequent
  full-state range, so distinguish device rejection/no-op from an unmapped
  response.
- [ ] Re-test Room Air Conditioner Auto after a meaningful Apple Home/Matter
  update and with a second Matter controller. Re-enable it only after the
  production device type writes `SystemMode.Auto` and renders authoritative
  state correctly.
- [ ] Verify the standard Celsius/Fahrenheit thermostat UI attribute with a
  controller that exposes it; keep actual temperatures canonical in Celsius.
- [ ] Determine whether a common Matter controller exposes Fan Only, Dry, and
  Sleep for this Room Air Conditioner. Apple Home and Eve currently do not.
- [ ] Expose Eco/Normal and Boost only when a useful standard Matter programming
  or preset surface is available.
- [ ] Continue omitting optional running-mode/compressor state until direct
  protocol evidence can distinguish actual compressor activity.

## Later / outside the first release

- [ ] Investigate authenticated-account WAVE 3 autodiscovery. Keep manual
  serial-number configuration until discovery is proven safe and strictly
  WAVE-3-specific.
- [ ] Consider optional per-device Night and Eco composed switch endpoints,
  disabled by default and derived only from confirmed device state.
- [ ] Add battery/charging state when an add-on battery is present.
- [ ] Add condensate-full warning, drainage state, and auto drainage when the
  protocol mapping and standard Matter presentation are both verified.
- [ ] Consider beeper, display brightness, timers, Pet Care, and charge limits
  only when a concrete standard Matter use case is approved.
- [ ] Treat local MQTT redirection, Bluetooth, or LAN control as separate
  experiments after Matter-backed cloud control is stable.
- [ ] Explore integrated cumulative energy from sampled AC power only after
  instantaneous power is proven. Treat it as an explicitly estimated,
  persisted counter with defined gap, restart, reset, clock-jump, and offline
  semantics—not as device-lifetime or accounting-grade energy. Prefer a real
  device Wh/kWh counter if one is identified first.

## Project records

- [Matter-only decision](docs/decisions/0003-matter-only.md)
- [Auto-mode interoperability decision](docs/decisions/0004-defer-matter-auto.md)
- [Electrical power decision](docs/decisions/0006-electrical-power.md)
- [Architecture comparison](docs/architecture-comparison.md)
- [Protocol dossier](docs/protocol.md)
- [Hardware evidence](docs/hardware-packet-evidence-2026-08-01.md)
- [Commissioning runbook](docs/commissioning.md)
