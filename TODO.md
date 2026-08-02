# Current

Migrate the existing hardware-validated WAVE 3 integration from its temporary
HAP `HeaterCooler` presentation to a Matter-only Homebridge 2 child bridge.

[Decision 0003](docs/decisions/0003-matter-only.md) governs this work. The
cloud, protocol, normalized-state, command-confirmation, rate-limiting, and
app-coexistence layers are retained. HAP is not a supported parallel target.

```text
EcoFlow cloud + WAVE 3 protocol
    -> confirmed Wave3Controller state and commands
    -> Matter-only presentation adapter
    -> one Matter-enabled EcoFlow child bridge
    -> Apple Home commissioning
```

## Completed — Phase M1: Matter-only platform contract

- [x] Require `api.isMatterEnabled()` / `api.matter` before starting device
  sessions; emit one clear configuration error and stop when Matter is absent.
- [x] Add Homebridge package metadata for Matter support and remove
  `supports-hap` and HAP-specific keywords.
- [x] Update plugin and bridge documentation for the required child-bridge
  configuration:

  ```json
  "_bridge": {
    "hap": { "enabled": false },
    "matter": { "enabled": true, "name": "EcoFlow WAVE 3" }
  }
  ```

- [x] Preserve the existing child-bridge debug-mode guidance; Matter selection
  and debug logging are independent settings.
- [x] Keep stable device UUIDs derived from the configured WAVE 3 identifier,
  but use `api.matter.uuid` at the presentation boundary.
- [x] Define the Matter accessory context needed for cache restoration,
  configuration reconciliation, and stale-device removal.

**Phase M1 exit:** the platform has an explicit Matter-only startup contract
and no implicit HAP fallback.

## Phase M2: Matter accessory and cluster mapping

- [x] Replace `Wave3PlatformAccessory` with a Matter presentation adapter that
  consumes only `Wave3Controller` snapshots and commands.
- [x] Register one Matter accessory per configured WAVE 3 through
  `api.matter.registerPlatformAccessories`.
- [x] Build one customized Matter `RoomAirConditioner` endpoint from
  Homebridge's exported `devices.RoomAirConditionerDevice` and
  `devices.RoomAirConditionerRequirements`.
- [x] Enable Heating, Cooling, and AutoMode on its Thermostat server rather
  than using Homebridge's narrower convenience `RoomAirConditioner` type
  unchanged.
- [x] Add the Room Air Conditioner's optional Fan Control server to the same
  endpoint. Do not create a separate Fan tile unless the standard optional
  cluster cannot be made to work through Homebridge's Matter API.
- [x] Initialize and update standard Matter state:
  - on/off power state
  - thermostat local temperature
  - occupied heating and cooling setpoints
  - system mode; omit optional running mode until the protocol supplies direct
    compressor-activity evidence
  - fan mode, percentage, and discrete WAVE speed mapping
  - ambient humidity when `currentTemperatureSource` is `ambient`
  - firmware revision and stable manufacturer/model/serial metadata
- [x] Preserve the per-device temperature-source contract:
  - `ambient` -> ambient local temperature plus humidity part
  - `outlet` -> indoor supply-air local temperature, no humidity part
  - `none` -> null/unavailable Matter local temperature and no humidity part
- [x] Update external device changes with
  `api.matter.updateAccessoryState`; do not mutate Matter state optimistically
  when an EcoFlow command is merely published.
- [x] Reconcile name/context while re-registering cached accessories and
  unregister stale Matter accessories by UUID. Homebridge 2.2.1's
  `updatePlatformAccessories` currently replaces its live internal accessory
  object and loses the endpoint, so do not call it until that upstream path is
  fixed.
- [x] Publish firmware through the standard bridged-device basic-information
  cluster (`softwareVersion` and `softwareVersionString`), because Homebridge
  2.2.1 does not map `MatterAccessory.firmwareRevision` onto the live bridged
  endpoint.
- [x] Treat Homebridge 2.2.1 bridged registration and state-update promises as
  event dispatch only: confirm endpoint readiness and every attribute mutation
  through `getAccessoryState`, confirm disappearance before same-UUID shape
  replacement, and drain or clean dispatched work during shutdown.
- [x] Set the standard Matter thermostat minimum setpoint deadband to zero so
  snapshot updates do not invent or transactionally reject a companion
  heat/cool setpoint that the WAVE is not currently controlling.
- [x] Keep the inactive companion heat/cool setpoint transactionally valid when
  a real WAVE target crosses it; verify cool-low and heat-high transitions in
  the installed Matter runtime for ambient, outlet, and no-temperature shapes.

**Phase M2 exit:** fake controller snapshots produce a complete Matter
accessory with stable identity, cache behavior, metadata, climate state, fan
state, and temperature-source variants.

## Phase M3: Matter command and error mapping

- [x] Treat `OnOff.onOff` as the sole authoritative Matter power surface:
  - `false` -> WAVE power off
  - `true` -> WAVE power on while retaining the last confirmed active mode
- [x] Translate Matter thermostat handlers into existing typed WAVE commands:
  - Cool
  - Heat
  - Auto
  - cooling and heating setpoints
  - setpoint raise/lower when Apple Home uses it
- [x] Translate Matter fan handlers into settled/coalesced WAVE fan-speed
  commands without creating a second power or mode authority.
- [x] Implement the verified Matter system-mode values through
  `Thermostat.systemMode`:
  - Auto = `0x01`
  - Cool = `0x03`
  - Heat = `0x04`
  - Fan Only = `0x07`
  - Dry = `0x08`
  - Sleep = `0x09`
- [x] Do not use `Thermostat.systemMode = Off` as the canonical power control;
  Room Air Conditioner power belongs to `OnOff.onOff`.
- [x] Use direct Matter cluster/type access when Homebridge's friendly device
  wrapper omits one of these standard enums or the AutoMode feature.
- [x] Map Eco, Normal, Sleep, and Boost submodes into standard Matter concepts
  where possible:
  - Sleep -> Matter Sleep system mode
  - Eco -> Matter economy programming flag or named preset
  - Normal -> clear the active special preset/programming mode
  - Boost -> a named preset only if the standard preset surface supports it
- [x] Do not add manufacturer-specific clusters merely to expose Eco or Boost;
  leave a mode unexposed when no standard Matter representation works.
- [x] Preserve existing controller safety:
  - 750 ms slider settling and latest-value coalescing
  - serialized commands
  - duplicate suppression
  - acknowledgement accumulation
  - observed-state confirmation
  - unrelated EcoFlow-app traffic filtering
- [x] Advertise the WAVE's real 16–30°C thermostat limits and preserve Matter's
  zero-deadband companion-setpoint behavior for direct and raise/lower writes.
- [x] Keep `FanMode`, `PercentSetting`, and five-level `SpeedSetting` coherent;
  accept Matter's nullable no-change writes, cancel queued airflow when power
  turns off, and suppress a coalesced write that returns to confirmed speed.
- [x] Linearize Matter commands before deriving state-dependent WAVE payloads,
  coalesce a Matter thermostat transaction's companion setpoint changes into
  one confirmed range command, and invalidate queued fan work immediately when
  power-off is requested even if a Homebridge state update is still pending.
- [x] Translate controller outcomes into standard Matter interaction errors
  for awaited Matter commands (`OnOff` and `SetpointRaiseLower`). Reject
  invalid or unavailable thermostat/fan attribute writes synchronously. The
  installed Matter.js runtime commits valid writable attributes before an
  asynchronous cloud command can finish, so later EcoFlow failures must be
  logged and reconciled to the last confirmed snapshot rather than falsely
  claimed as transactional Matter write failures.
- [x] Retain last confirmed Matter attributes through ordinary EcoFlow cloud
  and device gaps; use explicit reachability/account-failure state only where
  Homebridge's Matter bridge supports it without making Apple Home twitchy.

**Phase M3 exit:** every accepted Matter control reaches the existing
confirmed-state controller; awaited commands report standard Matter outcomes,
and writable attributes reconcile async failures without unhandled work or HAP
error types in the command path.

## Phase M4: Matter-focused automated verification

- [x] Add Matter registration, state, handler, and cache tests while retaining
  the legacy HAP test suite until its source is deleted in Phase M5.
- [x] Test complete and partial snapshot updates, including partial packets
  arriving before authoritative startup state.
- [x] Test all thermostat system modes, setpoints, fan speeds, humidity,
  firmware, and temperature-source variants.
- [x] Test stable endpoint UUIDs and cluster shape across cache restoration and
  all temperature-source variants; fan and humidity are clusters on the single
  Room Air Conditioner endpoint, not separately identified child parts.
- [x] Test command-handler error translation, timeout, reconnect during a
  command, and account/session failure.
- [x] Test multiple configured WAVE 3 units, duplicate prevention, metadata
  updates, stale Matter accessory removal, and restart/cache restoration.
- [x] Test that the plugin refuses to start device sessions when Matter is not
  enabled and never registers a HAP accessory.
- [x] Keep `npm run verify` independent of external network services and
  household hardware. Installed-runtime Matter probes intentionally bind local
  Matter/mDNS sockets.

**Phase M4 exit:** the aggregate suite proves the plugin publishes and controls
only Matter accessories while retaining the existing cloud/controller safety
properties.

## Next — Phase M5: Delete the HAP surface

- [ ] Delete `src/platformAccessory.ts` and replace its imports/usages with the
  Matter adapter.
- [ ] Delete HAP `PlatformAccessory`, `Service.HeaterCooler`,
  `HumiditySensor`, characteristic, `HapStatusError`, and cached-HAP lifecycle
  code.
- [ ] Delete HAP-specific tests and test doubles after equivalent Matter tests
  pass.
- [ ] Remove the direct `@homebridge/hap-nodejs` development dependency if no
  non-HAP test or type still needs it.
- [ ] Remove HAP configuration, troubleshooting, and product-language from
  `README.md`, `AGENTS.md`, and release metadata; retain historical HAP evidence
  only in git history and decision records.
- [ ] Update architecture diagrams and protocol notes so the presentation
  boundary is Matter, not HomeKit/HAP.

**Phase M5 exit:** the source tree contains no maintained HAP adapter or HAP
compatibility path.

## Phase M6: Child-bridge cutover and commissioning

- [ ] Pull/build/install the Matter-only plugin under the Saga account that
  runs this Homebridge child bridge.
- [ ] Stop using the existing HAP pairing and unpair the old EcoFlow WAVE 3
  child bridge from Apple Home.
- [ ] Disable HAP and enable Matter only for the EcoFlow child bridge; leave all
  other bridges and child bridges unchanged.
- [ ] Restart only the EcoFlow child bridge and confirm Homebridge produces a
  Matter commissioning QR code.
- [ ] Pair the Matter bridge to Apple Home and accept the expected uncertified
  Matter accessory warning if presented.
- [ ] Reassign the WAVE 3 to its room and deliberately rebuild any desired
  scenes or automations; do not assume HAP identity or automations migrate.
- [ ] Confirm one WAVE 3 appears as one coherent accessory and inspect whether
  composed Fan/Humidity parts create useful rather than confusing tiles.

**Phase M6 exit:** Apple Home is commissioned only to the EcoFlow Matter child
bridge; no EcoFlow HAP pairing remains.

## Phase M7: One-command-at-a-time Matter hardware acceptance

For every control: record pre-state, issue one Apple Home command, record the
EcoFlow acknowledgement and resulting telemetry, verify physical behavior,
and confirm Matter state does not rubber-band.

- [ ] Read-only state, current-temperature source, humidity, and firmware.
- [ ] Power on and power off.
- [ ] Cool mode and cooling setpoint.
- [ ] Heat mode and heating setpoint.
- [ ] Auto mode and both thresholds.
- [ ] Five fan speeds and rapid-slider coalescing.
- [ ] Fan Only mode.
- [ ] Dry mode.
- [ ] Sleep mode.
- [ ] Eco/Normal and Boost only if represented through standard Matter
  programming/preset semantics.
- [ ] `ambient`, `outlet`, and `none` temperature-source configurations.
- [ ] EcoFlow app and Matter control at the same time.
- [ ] MQTT reconnect, Homebridge child-bridge restart, WAVE power cycle, and an
  extended unattended session.
- [ ] Normal and per-child-bridge debug logging with all identifiers and
  credentials redacted.

**Phase M7 exit:** every exposed Matter control has repeatable household-device
evidence and stable Apple Home behavior.

## Phase M8: Matter-only release preparation

- [ ] Update the supported-controls list to distinguish tested, partially
  tested, and intentionally unexposed behavior.
- [ ] Add Matter-only installation, commissioning, re-pairing,
  troubleshooting, region, private-API risk, and uncertified-bridge guidance.
- [ ] Investigate authenticated-account WAVE 3 autodiscovery; retain manual
  serial configuration until it is proven safe and WAVE-3-specific.
- [ ] Run `npm run verify` and inspect `npm pack --dry-run`.
- [ ] Keep the package private until Julian explicitly approves publication.
- [ ] Prepare versioning, release notes, and npm metadata only after acceptance.

**Phase M8 exit:** the Matter-only plugin is reviewable as a release candidate;
publication remains a separate explicit decision.

## Later / outside the first Matter release

- [ ] Battery and charging state when an add-on battery is present.
- [ ] Condensate-full warning, drainage state, and auto drainage.
- [ ] Beeper, display brightness, timers, Pet Care, and charge limits only when
  a concrete standard Matter use case is approved.
- [ ] Electrical power/energy telemetry only if the standard Matter electrical
  clusters improve normal household use.
- [ ] Local MQTT redirection, Bluetooth, or LAN control only as separate
  experiments after Matter-backed cloud control is stable.
- [ ] Do not add other EcoFlow or older WAVE products to this repository.
