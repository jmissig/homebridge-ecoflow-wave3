# Current

Ship a reliable, Matter-only Homebridge 2.2.1 plugin for the EcoFlow WAVE 3.
The HAP migration, Matter commissioning, protocol boundary, command
confirmation, architecture hardening, and initial Apple Home pairing are
complete. Their history lives in git and the linked project documents rather
than this active checklist.

Current architecture and evidence:

- [Matter-only decision](docs/decisions/0003-matter-only.md)
- [Auto-mode interoperability decision](docs/decisions/0004-defer-matter-auto.md)
- [Electrical power decision](docs/decisions/0006-electrical-power.md)
- [Architecture comparison](docs/architecture-comparison.md)
- [Protocol dossier](docs/protocol.md)
- [Hardware evidence](docs/hardware-packet-evidence-2026-08-01.md)
- [Commissioning runbook](docs/commissioning.md)

## Now — controller ordering and WAVE mode profiles

Live Matter testing shows that transport, decoding, state reconciliation, and
ordinary power/fan/temperature writes work. The remaining control failures sit
at the boundary between Apple Home's write ordering and the WAVE's saved
per-mode profiles.

### 1. Make every mode transition explicitly sequential

- [x] Represent the user's desired destination as durable staged intent,
  separate from any command derived before wake-up.
- [x] When the WAVE is off:
  1. send power-on only and confirm the resulting operational state;
  2. re-plan from the latest authoritative snapshot;
  3. send the destination mode and confirm it;
  4. send the destination target and confirm it.
- [x] When the WAVE is already on, confirm the mode change before applying its
  target/range rather than assuming the hardware accepts both atomically.
- [x] Re-plan queued work after every confirmed step so a wake-up into a saved
  profile cannot turn the remaining operation into a stale or false no-op.
- [x] Let a newer Matter intent supersede the remaining steps of an older one;
  power-off cancels all queued mode, setpoint, and fan work immediately.
- [x] Add transcript-shaped regressions for Off→Heat, Off→Cool, and
  on-device mode changes where the WAVE first restores a saved profile.

### 2. Keep WAVE profiles authoritative and Matter values presentational

- [x] Retain independent confirmed profiles for Cool, Heat, Auto, Fan Only,
  and Dry, plus confirmed Sleep submode state, without copying values between
  modes.
- [x] Never infer a destination target from Matter's inactive companion
  heating/cooling setpoint.
- [x] Keep mode-only writes mode-only. Let the WAVE restore its independent
  destination profile, then mirror that confirmed active target into both
  constrained Matter setpoint attributes. Do not copy the source target into
  the destination WAVE profile. Source: household Cool→Heat trace and
  Julian's profile-sync model · 2026-08-02
- [x] Track which target/range values came from an explicit controller write
  versus projection needed only to keep Matter attributes transactionally
  valid.
- [x] Resolve the two-profile impedance mismatch: Apple Home presents one
  active manual target, while Matter constrains two companion attributes and
  the WAVE stores independent crossing profiles.
- [ ] Verify repeated Cool→Heat→Cool transitions make Apple Home follow each
  confirmed active WAVE target without changing either saved WAVE profile.

### 3. Keep Auto deferred without losing protocol support

- Auto is not advertised in Matter for now. Matter defines Auto as a distinct
  writable `SystemMode`, but Apple Home twice displayed Auto without writing
  that value and ignored a correctly reported Auto state. [decision: Julian ·
  2026-08-02](docs/decisions/0004-defer-matter-auto.md)
- [x] Preserve the verified WAVE protocol semantics: wire mode `5`, lower/upper
  thresholds, midpoint scalar target, 16–30°C limits, and a minimum 4°C range.
- [x] When the EcoFlow app selects Auto, retain its authoritative profile
  internally and present Cooling at the Auto upper threshold to Matter.
- [ ] Decode or safely diagnose the official app's Auto range-write
  acknowledgement fields. Accepted app writes did not change the subsequent
  full-state range, so distinguish device rejection/no-op from an unmapped
  response.
- [ ] Re-test Auto with a second Matter controller and after meaningful Apple
  Home/Homebridge Matter updates. Re-enable it only after a controller writes
  `SystemMode.Auto` and renders the authoritative report correctly.

### 4. Hardware acceptance for the corrected coordinator

For each test, change one thing, record the pre-state, Matter semantic write,
WAVE command/acknowledgement, authoritative resulting state, physical result,
and controller reconciliation.

- [ ] Off→Cool with an explicit target.
- [ ] Off→Heat with an explicit target that differs from the saved Heat
  profile.
- [ ] Cool→Heat→Cool profile restoration.
- [ ] Five fan speeds and rapid-slider coalescing.
- [ ] Concurrent EcoFlow app and Matter control without stale replay.
- [ ] MQTT reconnect, child-bridge restart, WAVE power cycle, and an extended
  unattended freshness window.
- [ ] Startup with recent cache versus missing/expired cache and exactly one
  explicit refresh.
- [x] Upgrade an older Auto-capable cached endpoint to the Heat/Cool-only
  Matter shape without restoring an illegal Auto value or requiring re-pairing.
- [ ] Normal and debug logs remain useful with credentials, identifiers, and
  raw payloads redacted.

## Matter presentation follow-up

- [ ] Verify the standard Celsius/Fahrenheit thermostat UI attribute with a
  controller that exposes it; keep all actual temperatures canonical in
  Celsius.
- [ ] Determine whether any common Matter controller exposes Fan Only, Dry,
  and Sleep for this Room Air Conditioner. Apple Home and Eve currently do
  not.
- [ ] Expose Eco/Normal and Boost only when a useful standard Matter
  programming or preset surface is available.
- [ ] Continue omitting optional running-mode/compressor state until direct
  protocol evidence can distinguish actual compressor activity.

## Next — standard Matter electrical power

- [x] Add WAVE display field `53` (`pow_get_ac`) to the pinned protobuf subset
  and normalize it as AC active power in watts. Do not substitute field `777`
  (`pow_get_self_consume`), which can include power drawn from an attached
  battery.
- [x] Accept sparse power-only packets as supplemental measurement evidence.
  They must not renew operational power/mode authority, rebase command state,
  or confirm a command.
- [x] Declare `electricalPowerMeasurement.activePower` on the existing Room Air
  Conditioner accessory. Let Homebridge 2.2.1 apply its standard
  `PowerTopology(TreeTopology)` and Electrical Sensor utility-device handling;
  do not create a separate composed child endpoint.
- [x] Convert finite nonnegative WAVE watts to Matter milliwatts and publish
  `null` when the measurement is unknown or stale. Publish zero only when the
  WAVE reports zero.
- [x] Add one optional advanced `freshnessTimeoutMinutes` setting, defaulting
  to five minutes. Use that single duration for independently timestamped
  categories of live cloud-derived knowledge, including operational authority,
  environmental telemetry, saved profiles, and electrical power; one category
  must not refresh another. Keep static firmware metadata, the ten-second
  command deadline, and the separate startup cache-restoration grace outside
  this setting.
- [x] Cover protobuf decoding, sparse merge behavior, independent freshness,
  explicit offline/account-error clearing, W-to-mW conversion, cache shape,
  Homebridge electrical-cluster defaults, and descriptor advertisement in
  tests before household validation.

## Release readiness

- [ ] Investigate authenticated-account WAVE 3 autodiscovery. Keep manual
  serial-number configuration until discovery is proven safe and strictly
  WAVE-3-specific.
- [ ] Complete the corrected coordinator and hardware acceptance above.
- [ ] Run `npm run verify` and inspect `npm pack --dry-run` for the release
  candidate.
- [ ] Review configuration schema, install/update instructions,
  troubleshooting, privacy language, and supported-controller caveats.
- [ ] Prepare versioning, release notes, changelog, and npm metadata.
- [ ] Keep the package private until Julian explicitly approves publication.

## Later / outside the first release

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
- [ ] Do not add other EcoFlow products or older WAVE generations to this
  repository.
