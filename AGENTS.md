# AGENTS.md -- homebridge-ecoflow-wave3

This file gives coding agents the durable context they need to work safely and consistently in this repository.

Preserve this plugin's narrow purpose. Do not broaden it into a general EcoFlow plugin, a compatibility layer for older WAVE products, or a generic MQTT/protobuf framework unless Julian explicitly asks.

## Project posture

Current posture: **Matter-only migration before first release**

This is a new, hardware-specific Homebridge plugin. Architecture, dependencies, configuration, and service mapping may change substantially while the first reliable WAVE 3 integration is established.

- Debate requirements, then commit to the accepted direction and remove superseded paths cleanly.
- Prefer current Homebridge 2 and TypeScript patterns over inherited Homebridge 1 compatibility.
- Backwards compatibility is not a goal before a real release and installed user configuration exist.
- Do not preserve exploratory code merely because it already exists.

Underlying philosophy: **software is ephemeral**. Old code should earn its keep. Keep the plugin small enough that correcting an early assumption is cheap.

## Project brief

`homebridge-ecoflow-wave3` is a focused Homebridge platform plugin for controlling an EcoFlow WAVE 3 portable air conditioner from Apple Home.

This project is:

- a Homebridge **2.0-only** plugin
- a contemporary TypeScript project based on the current official Homebridge dynamic-platform plugin template
- a WAVE 3 integration using EcoFlow's app-facing cloud API, MQTT topics, and protobuf messages where no supported WAVE 3 API exists
- a clean Matter climate surface over the subset of WAVE 3 behavior that is understood and verified

Source of truth and evidence:

- Homebridge plugin shape and lifecycle: the current `latest` branch of [`homebridge/homebridge-plugin-template`](https://github.com/homebridge/homebridge-plugin-template) and the current Homebridge 2 developer API
- Known WAVE 3 protocol shape: the WAVE 3 implementation in [`tolwi/hassio-ecoflow-cloud`](https://github.com/tolwi/hassio-ecoflow-cloud), especially `custom_components/ecoflow_cloud/devices/internal/wave3.py` and `custom_components/ecoflow_cloud/devices/internal/proto/wave3.proto`
- Final behavioral authority: observed state, acknowledgements, and results from the household WAVE 3
- Matter product behavior: what Matter expresses honestly and Apple Home renders clearly and reliably, not a one-for-one copy of Home Assistant entities

The Home Assistant implementation is valuable reverse-engineering evidence, not an official EcoFlow contract. Record uncertainty instead of presenting inferred fields as settled facts.

Non-goals / anti-goals:

- no support for other EcoFlow product families
- no support for WAVE, WAVE 2, or earlier air conditioners
- no Homebridge 1 compatibility
- no generic EcoFlow SDK, generic device registry, or all-product abstraction
- no public-API compatibility path intended for unrelated or older EcoFlow devices
- no Home Assistant feature-parity checklist
- no permanent HAP compatibility surface; the accepted destination is Matter-only
- no speculative local MQTT, Bluetooth, or LAN-control subsystem in the first working slice

Attractive but wrong expansion: **do not turn this into the universal EcoFlow plugin.** Build the small WAVE 3 climate integration that actually works.

## Accepted implementation baseline

Start from the current official Homebridge plugin template rather than reconstructing an older plugin by hand.

At scaffold or major toolchain-refresh time:

1. Inspect the `latest` branch of `homebridge/homebridge-plugin-template`.
2. Preserve its current project layout, ESM posture, TypeScript settings, lint setup, default-export initializer, dynamic-platform lifecycle, and development harness unless this plugin has a concrete reason to differ.
3. Record the template commit used in the implementation handoff or commit message.
4. Narrow `engines.homebridge` to Homebridge 2 only.
5. Set `engines.node` to Node 24 or newer. Do not retain Node 22 or older compatibility.
6. Remove example devices, custom-service examples, timers, and template comments that do not explain real WAVE 3 code.

As of 2026-07-28, the official template uses:

- ESM with `"type": "module"`
- NodeNext module and module-resolution settings
- explicit `.js` suffixes in relative TypeScript imports
- strict TypeScript
- a default-export plugin initializer
- a `DynamicPlatformPlugin`
- Homebridge 2 as the development dependency
- Node 24 or newer for this project, intentionally narrower than the template

Treat that list as a checked reference, not a permanently frozen dependency manifest. Re-check the template when the implementation begins or the toolchain is refreshed.

This repository may contain exploratory scaffold files created before these constraints were clarified. Converge or rebuild them against the accepted baseline; do not preserve CommonJS, Homebridge 1 support, or stale dependency versions out of inertia.

## Product and Matter shape

Use a dynamic platform because it fits Homebridge's current template and cached-accessory lifecycle. Keep discovery intentionally narrow:

- represent only explicitly configured WAVE 3 units
- ignore unrelated EcoFlow devices returned by an account
- derive stable accessory UUIDs from a stable WAVE 3 identifier such as its serial number
- restore, update, and remove cached accessories through Homebridge's platform APIs

The primary Matter surface should be climate-first:

- one WAVE 3 accessory
- one customized Matter `RoomAirConditioner` endpoint built from Homebridge's
  exported low-level Matter device requirements, with Heating, Cooling,
  AutoMode, and FanControl enabled
- `OnOff.onOff` is authoritative for appliance power; `Thermostat.systemMode`
  selects the active HVAC mode and does not replace the power cluster
- Off, Cool, Heat, Auto, Fan Only, Dry, and Sleep system modes where behavior
  is verified
- current temperature and cooling/heating setpoints appropriate to the selected
  per-device temperature source
- ambient humidity only when the ambient temperature source is selected
- firmware revision in standard Matter bridged-device metadata

WAVE 3 behaviors known from the Home Assistant implementation include cool, heat, dry, fan, and auto modes, temperature and humidity targets, drainage controls, beeper, display settings, timers, power telemetry, battery telemetry, temperatures, and condensate state.

Do not expose every known field merely because it exists. For Eco, Boost,
battery, condensate state, drainage, beeper, display, timers, and diagnostics:

- first ask whether standard Matter clusters, modes, presets, and attributes
  express the behavior honestly
- prefer a composed Matter endpoint only when it improves normal controller use
- avoid duplicate controls that can fight over the same WAVE 3 mode
- keep diagnostic telemetry out of the primary climate surface
- do not invent manufacturer-specific clusters by default

## Protocol and control model

Keep Homebridge, device control, cloud transport, and protobuf concerns separate:

```text
Homebridge platform lifecycle
    -> WAVE 3 Matter accessory mapping
    -> WAVE 3 controller and normalized state
    -> EcoFlow private app client
    -> HTTPS authentication + cloud MQTT
    -> WAVE 3 protobuf codec
```

Responsibilities:

- **Platform** -- validate config, manage cached accessories, start and stop device sessions
- **Accessory** -- map normalized WAVE 3 state and commands to standard Matter
  devices, clusters, attributes, and command handlers
- **Controller** -- own normalized state, command sequencing, acknowledgement, timeouts, refresh, and reconnect behavior
- **Private client** -- own login, regional API host, temporary MQTT credentials, TLS, subscriptions, publication, and lifecycle
- **Protocol codec** -- encode and decode typed WAVE 3 messages without Homebridge dependencies

Rules:

- Keep raw protobuf field names and topic details below the controller boundary.
- Do not let Matter handlers construct MQTT topics or protobuf objects.
- Do not treat successful MQTT publication as successful device control.
- Prefer device telemetry or a correlated acknowledgement as confirmation.
- Keep Matter reads fast; return cached normalized state and update cluster
  attributes asynchronously from device events.
- Make offline, stale, rejected, and timed-out states explicit.
- Re-subscribe and request current state after reconnect.
- Ensure shutdown closes MQTT connections and timers cleanly.
- Assume the private API can change without notice and make failures diagnosable without leaking secrets.

Current upstream evidence indicates:

- WAVE 3 uses app-facing `/app/...` MQTT topics and protobuf payloads.
- Power-on and power-off commands are asymmetric.
- `cfg_main_power` is used to turn the unit on.
- `cfg_sys_pause` is used to turn the unit off.
- `dev_sleep_state` is the observed power-state indicator used to avoid UI state rubber-banding.

Treat these as protocol hypotheses until verified against the household WAVE 3. A copied field number or command shape is not complete support.

## TypeScript and dependency posture

- Use strict contemporary TypeScript.
- Use ESM and NodeNext consistently with the official template.
- Prefer `import type` for type-only imports.
- Keep unsafe casts and `any` at narrow external-data boundaries; validate before normalized values enter the controller.
- Prefer small typed domain values over bags of optional unvalidated properties.
- Use Node built-ins and small focused packages where practical.
- Keep runtime dependencies few and directly justified.
- Use a maintained MQTT client and a maintained protobuf implementation rather than writing either protocol stack from scratch.
- Do not add `homebridge-lib`, HAP compatibility types, or a second accessory
  framework. Use Homebridge 2's `api.matter` surface and its direct Matter.js
  cluster/type access.
- Do not introduce a framework for dependency injection, state management, validation, retries, or events when a small explicit boundary is clearer.

For toolchain and dependency updates, compare against the current official template first. The template is the default; local divergence should be intentional and documented.

## Configuration and secrets

Configuration should be the smallest set needed for a WAVE 3 session and useful
Matter/Apple Home naming.

- Use `config.schema.json` with strict, helpful validation and Homebridge UI labels.
- Support the regional EcoFlow API host when required; do not silently send credentials to an arbitrary host.
- Require explicit WAVE 3 serials because the pinned private API path exposes
  no device-list endpoint.
- Treat configured serials as WAVE 3 at this evidence level; hardware
  validation must confirm the household unit before release.
- Never log passwords, bearer tokens, MQTT usernames/passwords, authorization headers, full device serial numbers, or identifying raw payloads.
- Redact identifiers in debug logs and bug-report instructions.
- Do not commit real Homebridge config, account details, certificates, MQTT credentials, serial numbers, or packet captures.

## Protocol provenance and licensing

The WAVE 3 mapping is adapted from the Apache-2.0-licensed `tolwi/hassio-ecoflow-cloud` project.

- Preserve the original Apache-2.0 license obligations for copied or substantially adapted material.
- Protocol-derived source files must carry an SPDX header and a clear modification notice.
- Keep `THIRD_PARTY_NOTICES.md` and `LICENSES/Apache-2.0.txt` current.
- Prefer documenting the exact upstream file and commit used.
- Do not mechanically copy the entire upstream protobuf schema when a reviewed WAVE 3 subset is sufficient.
- Original project code remains under this repository's declared license.

## Current state

The repository is pre-release. Its EcoFlow authentication, cloud MQTT,
protobuf, normalized state, command confirmation, app coexistence, and core
power/temperature/fan control paths have a household WAVE 3 hardware baseline.

The current checked-in presentation is still HAP `HeaterCooler`; it is a
temporary implementation to be replaced by the Matter-only plan in `TODO.md`
and [Decision 0003](docs/decisions/0003-matter-only.md). Do not add new HAP
features or preserve HAP compatibility during that migration.

Do not describe a command or service as supported merely because it compiles, has a plausible protobuf field, or matches a Home Assistant implementation.

## Validation

Routine checks should be available through:

```bash
npm run lint
npm test
npm run build
```

Provide a single aggregate command:

```bash
npm run verify
```

`npm run verify` should run lint, tests, and a clean TypeScript build without using a real EcoFlow account, live MQTT broker, Homebridge installation, or household device.

Tests should cover:

- configuration validation
- protobuf encoding and decoding with synthetic or anonymized fixtures
- normalized state mapping
- command generation
- acknowledgement and timeout behavior
- reconnect, re-subscribe, and refresh behavior
- Matter device, cluster, mode, attribute, and command mapping
- cached-accessory restoration and stale-accessory removal where practical
- redaction of sensitive log values

Use fakes at the transport and controller boundaries. Keep protocol tests deterministic.

Do not run during routine verification:

- `npm link`, global installs, publishing, or release commands
- a live Homebridge instance
- commands that write to the operator's default Homebridge configuration or accessory cache
- authentication against a real EcoFlow account
- publication to the real EcoFlow MQTT broker
- commands against the household WAVE 3

Live-device work is a separate explicit validation phase. Run it in an isolated Homebridge 2 child bridge, test one bounded command at a time, and record the observed acknowledgement and resulting state before calling that command supported.

## Failure signals

Pause and re-evaluate if:

- the plugin begins acquiring support tables or abstractions for non-WAVE-3 devices
- Homebridge 1 or pre-Node-24 compatibility starts shaping the code
- Matter handlers depend directly on MQTT or protobuf details
- a published command immediately updates Matter state without device confirmation
- reconnects create duplicate listeners, subscriptions, accessories, or timers
- the official EcoFlow app and plugin cannot coexist reliably
- logs or fixtures contain credentials, full serial numbers, or identifying payloads
- companion services outnumber or obscure the primary climate controls
- an upstream Home Assistant field is treated as verified without local evidence
- template example code or compatibility scaffolding survives without a real purpose

## Documentation and project hygiene

Use the standard Julian-owned project split:

- `README.md` -- human-facing purpose, installation, configuration, supported controls, limitations, and operator workflow
- `TODO.md` -- active backlog and unresolved validation work
- `AGENTS.md` -- durable scope, architecture, safety, provenance, and agent guidance
- focused protocol notes or fixture documentation -- details that would bloat this file

Keep “known from upstream,” “locally verified,” and “still inferred” visibly distinct in documentation.

When a protocol or product decision changes, record:

- date
- decision
- evidence
- alternatives considered
- migration impact

Remove completed items from `TODO.md`; completed work belongs in code, tests, documentation, release notes, and git history.

## GitHub and release actions

Read-only GitHub research is fine when needed.

Before GitHub-facing writes, npm publication, tagging, or release creation:

- ensure Julian has reviewed and owns the change
- confirm no credentials, packet captures, or identifying device data are present
- confirm the supported-control list matches hardware validation
- run the documented verification commands
- do not add AI-generated footers or co-author lines

Do not publish or present the plugin as production-ready until it has passed Homebridge 2 child-bridge and real-device validation.

## Working style for agents

- Start with `AGENTS.md`, `README.md`, `TODO.md`, `package.json`, and current git state.
- Check the current official Homebridge template before scaffold or toolchain work.
- Use the Home Assistant WAVE 3 implementation as evidence, then narrow it to
  the Matter climate job.
- Make one coherent slice at a time: protocol evidence, typed codec, controller
  behavior, or Matter mapping.
- Separate fixture-backed confidence from live-device confidence.
- Keep changes small enough to review before touching the household device.
- When uncertain, choose the WAVE-3-only interpretation and ask before broadening scope.

## Final rule

Build the small WAVE 3 climate plugin that works.

Do not build an EcoFlow empire.
