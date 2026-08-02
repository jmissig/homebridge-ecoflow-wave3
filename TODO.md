# Current

Build a narrow, testable Homebridge 2 plugin by porting only the WAVE 3
knowledge we need from the Home Assistant EcoFlow Cloud integration.

The implementation order is deliberate:

```text
upstream evidence
    -> typed WAVE 3 protocol
    -> fakeable EcoFlow cloud session
    -> confirmed controller state
    -> HomeKit climate mapping
    -> read-only hardware observation
    -> one-at-a-time command validation
```

Do not skip from upstream field names directly to live-device writes.

## Now — Phase 1: Protocol dossier and port boundary

- [x] Pin the exact upstream `tolwi/hassio-ecoflow-cloud` commit used for the
  first port.
- [x] Create a focused protocol note that traces each imported behavior to its
  upstream file and field:
  - authentication and regional API hosts
  - WAVE 3 account discovery and device identification
  - MQTT credential acquisition and broker options
  - `/app/...` publish and subscribe topics
  - WAVE 3 message envelope, command IDs, sequence IDs, and payload transform
  - display, runtime, and command-acknowledgement messages
  - power, operating mode, temperature, humidity, fan speed, and submode fields
- [x] Separate three confidence levels in the protocol note:
  - known from upstream code
  - inferred from upstream behavior or comments
  - verified against the household WAVE 3
- [x] Review the upstream protobuf schema and select the smallest coherent
  WAVE-3-only subset needed for the first climate slice.
- [x] Compare maintained TypeScript protobuf options and choose the smallest
  toolchain that supports proto3 optional fields and deterministic tests.
- [x] Record the upstream commit and copied/adapted files in
  `THIRD_PARTY_NOTICES.md`; add SPDX and modification notices to derived files.
- [x] Replace the empty test harness with a TypeScript-capable unit-test setup
  before protocol code lands.

**Phase 1 exit:** every field and message planned for the first slice has a
traceable upstream origin, explicit confidence level, licensing plan, and test
strategy.

Primary upstream evidence:

- [`wave3.py`](https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/internal/wave3.py)
- [`wave3.proto`](https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/internal/proto/wave3.proto)
- [Initial WAVE 3 implementation PR #762](https://github.com/tolwi/hassio-ecoflow-cloud/pull/762)

## Phase 2: Typed WAVE 3 codec and domain state

- [x] Add the reviewed protobuf subset with Apache-2.0 provenance.
- [x] Implement a Homebridge-independent WAVE 3 codec:
  - decode the outer message envelope
  - apply the observed payload transform only under the evidenced conditions
  - decode display, runtime, and command-acknowledgement payloads
  - encode configuration-write commands with explicit sequence IDs
- [x] Define a small normalized `Wave3State` with no Homebridge, MQTT, or raw
  protobuf types.
- [x] Normalize the first-slice state:
  - sleeping / powered state
  - operating mode
  - ambient temperature and humidity
  - target temperature or automatic temperature range
  - airflow speed
  - current submode
- [x] Define typed first-slice commands:
  - power on via `cfg_main_power`
  - power off via `cfg_sys_pause`
  - cool, heat, auto, and fan modes
  - target temperature and automatic upper/lower thresholds
  - airflow speed
  - supported operating submodes
- [x] Preserve unknown fields and unsupported messages as bounded diagnostics,
  not crashes or silently invented state.
- [x] Add synthetic fixture tests for envelope routing, payload transforms,
  state normalization, command encoding, sequence preservation, malformed
  messages, and unknown command IDs.

**Phase 2 exit:** protocol tests can decode known synthetic messages and encode
the first command set without importing Homebridge or connecting to EcoFlow.

## Phase 3: Private EcoFlow cloud session

- [x] Define strict typed plugin configuration and `config.schema.json` fields
  for account login, region/API host, display name, and required WAVE 3 serial
  number.
- [x] Constrain API hosts to reviewed EcoFlow regional endpoints by default;
  require an explicit advanced override for any other host.
- [x] Implement the private HTTPS authentication flow without logging
  passwords, tokens, authorization headers, or full device identifiers.
- [x] Treat every configured serial as WAVE 3 because the pinned private API
  exposes no device-list endpoint; do not query or register unrelated EcoFlow
  products.
- [x] Acquire temporary MQTT credentials and connect with TLS verification.
- [x] Implement WAVE-3-only topic construction, subscription, initial state
  refresh, publication, disconnect, and clean shutdown.
- [x] Re-subscribe and request current state after every reconnect without
  duplicating listeners or timers.
- [x] Put HTTP and MQTT behind fakeable boundaries.
- [x] Test success, invalid credentials, wrong region, missing/invalid serial,
  multiple configured WAVE 3 units, disconnect, reconnect, subscription
  failure, refresh failure, and secret redaction without using a live account.

**Phase 3 exit:** a fully fake-backed session can authenticate, configure only
explicit WAVE 3 serials, subscribe, refresh, reconnect, publish bytes, and shut
down cleanly.

## Phase 4: Confirmed-state controller

- [x] Build one controller per WAVE 3 around the codec and cloud session.
- [x] Merge partial display/runtime messages into immutable normalized state.
- [x] Track online, stale, reconnecting, and stopped states explicitly.
- [x] Correlate command acknowledgements by sequence ID where the protocol
  supports it.
- [x] Distinguish MQTT publication, broker acknowledgement, WAVE command
  acknowledgement, and observed device-state confirmation.
- [x] Define bounded command timeouts and error results.
- [x] Do not make optimistic state the authoritative HomeKit state.
- [x] Coalesce or serialize conflicting climate commands so mode and target
  changes cannot race.
- [x] Add deterministic tests for partial updates, stale state, delayed
  acknowledgements, rejected/unknown acknowledgements, timeouts, reconnect
  during a command, duplicate messages, and out-of-order state.

**Phase 4 exit:** fake transports demonstrate that commands succeed only under
the chosen acknowledgement/state-confirmation policy and fail predictably
otherwise.

## Complete — Phase 5: Homebridge platform and primary climate accessory

- [x] Validate config before starting any account or MQTT work.
- [x] Discover/register only WAVE 3 accessories after
  `didFinishLaunching`.
- [x] Use the WAVE 3 serial number or another verified stable identifier for
  accessory UUID generation while redacting it from logs.
- [x] Restore existing cached accessories, update their context safely, and
  remove stale WAVE-3-only accessories.
- [x] Map the controller to one primary `HeaterCooler` service:
  - `Active`
  - `CurrentHeaterCoolerState`
  - `TargetHeaterCoolerState`
  - `CurrentTemperature`
  - cooling and heating thresholds
  - `RotationSpeed` if the five-step mapping remains valid
- [x] Keep characteristic getters fast and backed by cached confirmed state.
- [x] Push device events asynchronously into HomeKit characteristics.
- [x] Surface offline/stale/command-failure state with standard HAP behavior.
- [x] Test characteristic-to-command mapping and state-to-characteristic
  mapping without a live bridge or device.
- [x] Test platform cache restoration, duplicate prevention, and stale removal.

**Phase 5 exit:** fake controller tests exercise the complete HomeKit climate
surface while `npm run verify` remains network- and hardware-independent.

## Phase 6: Read-only household WAVE 3 validation

- [ ] Use an isolated Homebridge 2 child bridge and a dedicated development
  config/cache.
- [ ] Validate login, regional host selection, WAVE 3 discovery, MQTT
  connection, subscription, initial refresh, and clean shutdown.
- [ ] Observe state only; do not send control commands in the first live run.
- [ ] Confirm message routing and normalized values for power, mode, ambient
  temperature, humidity, target settings, and fan speed.
- [ ] Confirm the EcoFlow app and plugin can remain connected simultaneously.
- [ ] Verify Home retains the last confirmed presentation through stale,
  reconnecting, and device-offline periods while writes remain blocked.
  [told: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533277123425472562)
- [ ] Exercise disconnect/reconnect and verify subscriptions and refresh
  recover once.
- [ ] Capture the smallest useful anonymized binary fixtures for display,
  runtime, and acknowledgement messages.
- [ ] Review fixtures and logs for credentials, tokens, full serial numbers,
  account identifiers, and other identifying payload data before commit.

**Phase 6 exit:** read-only live behavior matches the normalized model,
reconnect works, fixtures are safely anonymized, and no device command has
been sent.

## Phase 7: One-command-at-a-time hardware validation

Validate each command in a separate bounded pass. For every item:

1. record pre-command device state
2. send one command
3. record MQTT acknowledgement
4. observe resulting device telemetry and physical behavior
5. verify HomeKit state does not rubber-band
6. mark the behavior supported, revise the mapping, or leave it unsupported

- [ ] Power on.
- [ ] Power off.
- [ ] Cool mode.
- [ ] Heat mode.
- [ ] Auto / heat-cool mode.
- [ ] Target temperature in cool mode.
- [ ] Target temperature in heat mode.
- [ ] Re-test HomeKit temperature-slider writes after latest-value coalescing;
  verify rapid movement emits one settled command per threshold.
- [ ] Automatic lower and upper temperature thresholds.
- [ ] Fan-only mode.
- [ ] Five fan-speed levels.
- [ ] Re-test HomeKit fan-speed slider writes after latest-value coalescing;
  verify rapid slider movement emits one settled command and does not restart
  the appliance control cycle.
- [ ] Reconnect after the device has accepted commands for an extended session.
- [ ] Confirm whether command acceptance degrades over time and, if so,
  identify the smallest evidenced refresh or reconnect behavior.
- [ ] Maintain a supported-controls section that distinguishes tested,
  partially tested, and unsupported behavior.

**Phase 7 exit:** every control exposed by the primary HomeKit surface has
repeatable real-device evidence.

## Phase 8: Secondary HomeKit surfaces

Evaluate these only after the primary climate accessory is reliable:

- [ ] Confirm how Homebridge, HomeKit, and the Home app represent fan-only
  operation; add it if it can be expressed honestly, either within
  `HeaterCooler` or as one carefully synchronized `Fanv2` companion service.
  [told: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533271556359196834)
- [ ] Decide whether dry mode can be represented honestly with standard
  HomeKit services and characteristics.
- [ ] Evaluate battery level and charging state when an add-on battery is
  actually present.
- [ ] Evaluate condensate-full warning and drainage state.
- [ ] Evaluate auto drainage, beeper, display brightness, and presets only
  when they improve normal household use.
- [ ] Keep timers, deep diagnostics, Pet Care, charge limits, and unrelated
  power telemetry out unless a concrete HomeKit use case is approved.
- [ ] Add hardware evidence and tests for each secondary surface before
  exposing it.

**Phase 8 exit:** any companion service has a clear Home app purpose, standard
HomeKit semantics, hardware evidence, and no conflicting controls.

## Phase 9: Child-bridge acceptance and release preparation

- [ ] Confirm Apple Home displays the observed PD firmware revision
  (`1.1.0.104` in the first household packet) in accessory information and
  retains it across partial updates and restarts.
  [told: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533271556359196834)
  [decision: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533305130429059072)
- [ ] Hardware-check all three per-device current-temperature sources:
  `ambient`, provisionally mapped field-494 `outlet`, and experimental `none`.
  Confirm whether Apple Home accepts a `HeaterCooler` with its normally
  required `CurrentTemperature` characteristic removed. Ambient alone should
  retain the humidity companion.
  [told: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533272228437692630)
  [decision: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533304877189431447)
- [ ] Verify Home app presentation, naming, room assignment, status updates,
  and “No Response” behavior.
- [ ] Verify useful Siri phrases for power, mode, temperature, and fan speed.
- [ ] Run extended child-bridge testing across broker reconnects, Homebridge
  restarts, EcoFlow app use, and WAVE 3 power cycles.
- [ ] Confirm logs remain useful at normal and debug levels without leaking
  secrets.
- [ ] Investigate whether the current private app API or MQTT data can reliably
  discover WAVE 3 devices for the authenticated account; if so, replace or
  supplement required manual serial-number entry with auto-discovery.
  [told: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533271556359196834)
- [ ] Update `README.md` so configuration and supported controls match only
  what was hardware-validated.
- [ ] Add installation, troubleshooting, region selection, child-bridge, and
  private-API risk guidance.
- [ ] Run `npm run verify` and inspect `npm pack --dry-run`.
- [ ] Keep the package private until Julian explicitly approves publication.
- [ ] Prepare versioning, release notes, and npm metadata only after acceptance.

**Phase 9 exit:** the plugin is reviewable as a release candidate; publication
remains a separate explicit decision.

## Later / explicitly out of the first release

- [ ] Investigate local MQTT redirection only as a separate experiment after
  cloud-backed control is stable.
- [ ] Investigate Bluetooth or LAN control only as a separate experiment.
- [ ] Revisit Matter only if Julian explicitly changes the HAP-only direction.
- [ ] Do not add other EcoFlow or older WAVE products to this repository.
