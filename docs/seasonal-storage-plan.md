# Seasonal Storage — implementation plan

Status: implemented locally with automated verification; household acceptance
remains in TODO. Requested by Julian on 2026-09-24.
Return policy: manual, selected by Julian on 2026-09-24 so the Homebridge
setting remains accurate.
Baseline inspected: `0581fb9` (package 0.4.4).

## Goal

Let a deliberately powered-down, seasonally stored WAVE 3 remain paired in
Apple Home without a persistent No Response indication. Preserve its identity,
room, scenes, and automations; do not remove or recreate its Matter endpoint.

This is an explicit user-selected presentation policy, not evidence that the
physical appliance is reachable. Normal operation must retain truthful fault
reporting and the existing fresh-state requirements for device commands.

## Selected experience

- Add **Seasonal Storage** to each configured WAVE 3 in Homebridge UI, default
  off; JSON field: `devices[].seasonalStorage`, strictly boolean.
- Help text: "After powering down this WAVE for storage, enable this option
  and restart the EcoFlow child bridge. Apple Home will show it as Off while
  stored and offline. To restore controls, turn this option off and restart
  the child bridge; fresh device state is also required."
- The user powers down the appliance first. Enabling storage does not send a
  power-off command or otherwise change the physical device.
- Save and restart only the EcoFlow child bridge through the normal operator
  workflow. No hot-reload mechanism or custom Homebridge UI is needed in v1.
- Keep the existing name, UUID, endpoint, cluster layout, and pairing.
- While stored, aim for an ordinary **Off** tile, not a new Storage tile.
  A custom "Stored" label is not promised in Apple Home.
- Report storage entry and exit once in Homebridge logs. Do not emit repeated
  warnings merely because a stored WAVE is absent. Real account/transport
  errors remain diagnosable in Homebridge.

### Return to service — manual (decided)

The configured checkbox is the sole authority for the storage policy:

- Configuration true: storage remains enabled across device power cycles,
  reconnects, and child-bridge restarts. All external controls stay locked.
- Configuration false: normal presentation and control admission apply after
  the configuration is saved and the EcoFlow child bridge is restarted.
- Restoring controls also requires fresh, authoritative power/mode state from
  the current cloud-session generation. A broker connection, old cloud/cache
  data, acknowledgement alone, or a sensor-only packet is not enough.

If the WAVE comes online while storage is still enabled, display its fresh
actual state read-only rather than falsely showing Off while it runs. Log once
that the device is online but Seasonal Storage still blocks controls. Fresh
telemetry never unchecks, consumes, or bypasses the setting. If the WAVE goes
offline again while the option remains enabled, restore the storage Off
presentation. Normal offline fault reporting resumes only after manual exit.

Do not add episode markers, completion latches, automatic configuration edits,
or a second return-policy setting. Homebridge configuration already persists
the user's choice; no separate storage lifecycle needs to be persisted.

Decision rationale: the visible Homebridge setting must accurately describe
the active policy. This replaces the earlier automatic-return proposal.

## Matter presentation contract

Storage is an override at the accessory/presentation boundary. Never mutate
the controller's real availability or manufacture confirmed device state.
The synthetic values below apply only while storage is enabled and fresh
operational state is unavailable. With fresh operational state, show the
ordinary live projection (respecting independent sensor freshness) read-only;
the configuration-based command lock still applies.

- `OnOff.onOff = false` and fan mode/settings/current values reflect the
  virtual Off presentation.
- Retain the last valid HVAC mode and saved setpoints using the existing
  OnOff-authoritative model; do not overwrite device profiles with storage
  defaults or force a Thermostat mode change merely to display Off.
- Publish `null` for room temperature, humidity, and electrical active power;
  do not show stale readings or claim measured zero watts.
- Keep firmware metadata and temperature-unit preference.
- Publish `BridgedDeviceBasicInformation.reachable = true` only as the explicit
  storage presentation override. This departs from physical reachability
  semantics and must be documented as such, not described as native Matter
  seasonal-storage support.
- Do not advance `lastConfirmedAt` or replace the last real confirmed snapshot
  when applying synthetic storage values. On exit, use fresh controller state,
  not the synthetic cached Off values, as command authority.
- If storage is disabled while still offline, immediately return to normal
  unavailable presentation; synthetic cache must not earn a freshness grace.

The child bridge itself must remain running and reachable. This feature cannot
hide a stopped Homebridge process, an unavailable home hub, or LAN failure.

## Commands and transition safety

- Reject all external control writes during effective storage with the
  existing Matter `InvalidInState` mechanism. Do not acknowledge commands as
  device successes and do not queue them for later, including Off writes.
- Cover power, HVAC mode, both setpoints, raise/lower, all fan controls, and
  temperature-unit writes. Guard before staging/coalescing and again before
  queued execution. Internal projection writes remain permitted.
- Cancel staged thermostat intent, pending temperature/fan changes, and delayed
  rollbacks when entering storage or crossing the return boundary. Superseded
  callbacks must not restore an old powered-on or reachable snapshot.
- Use a small presentation generation/version guard where needed so delayed
  updates cannot overwrite the new policy. Never cancel the shared MQTT
  connection merely to discard one accessory's pending work.
- Serialize return-to-service projection. Do not release normal controls until
  storage is manually disabled and fresh state has been applied successfully.
  A rejected/failed Matter update
  must remain eligible for retry, not be treated as delivered by deduplication.

## Transport and architecture scope

Keep the shared account session and existing protocol/controller authority.
Retain MQTT subscriptions so a stored unit can be detected when powered on.
Do not add a second connection, a polling framework, or dependencies.

Expected implementation locations:

1. `config.schema.json`, `src/ecoflow/config.ts`: per-device boolean and matching
   runtime validation/default. Existing configs retain current behavior.
2. `src/matter/context.ts`: no storage episode metadata needed. Preserve the
   existing context and do not bump the endpoint-shape schema version.
3. Small policy helper under `src/matter/`: deterministic storage transitions
   and effective presentation policy; no generic state-machine framework.
4. `src/platform.ts`: pass device policy to the binding and prepare storage
   presentation before registration.
   No unregister/re-register, new parts, or device-type changes.
5. `src/matter/projection.ts`, `src/matterAccessory.ts`: storage projection,
   command admission, cancellation, startup/rollback/cache integration, and
   confirmed delivery. All publication paths must respect the current policy.
6. `src/ecoflow/session.ts`, only if needed: reuse existing per-device retry
   machinery with a slower storage cadence, retaining subscriptions and a
   bounded read-only discovery path. Inspect existing retry behavior first;
   do not silence shared account failures or change active devices' cadence.

Do not use the action-71 full-display request repeatedly to probe a stored
appliance. Audit its startup dispatch and the latestQuotas retry path. Prefer
existing passive telemetry plus bounded read-only refresh, and verify wake
detection with the actual device. Storage is not permission to send controls.

## Implementation order and acceptance

### 1. Prove the presentation contract

Use the existing real-Matter endpoint test harness to exercise the current
Room Air Conditioner with Off, null sensor values, and reachable true. Check
that no endpoint-shape change is necessary and rejected writes leave Off
intact. This verifies protocol behavior, not Apple Home rendering.

### 2. Implement configuration and policy

Add strict schema/parser tests, per-device isolation, policy transitions,
configuration persistence across restart, and startup projection. With the setting
omitted/false, existing behavior must be unchanged.

### 3. Integrate command and update lifecycle

Test storage against cached powered-on state, old timers, queued slider writes,
in-flight failures, rollback, and failed Matter state delivery. Fix only the
review findings necessary for these paths; track unrelated resilience work
separately rather than silently expanding this feature into a rewrite.

### 4. Automated regression checks

- Storage with recent, expired, missing, and synthetic cached state.
- Restart with storage enabled; restart after manually disabling storage.
- No fabricated freshness or device-online state.
- Every command family rejected with zero control publications while stored;
  no rejected command replay after return.
- No telemetry, including fresh authoritative state, can end storage or unlock
  controls while the option is enabled.
- Fresh current-generation operational evidence restores actual read-only
  presentation while storage stays enabled; a subsequent offline transition
  restores the synthetic storage projection.
- Sensor-only, stale-generation, and cached reports cannot establish live
  operational presentation or command authority.
- Manual exit plus fresh operational state restores controls. Subsequent
  outages produce normal No Response.
- One stored WAVE does not affect a second active WAVE or the shared session.
- Failed updates retry; deferred snapshots/rollback cannot override policy.
- Turning storage off while offline restores unavailable state without cache
  grace; enabling it while already live does not conceal a running appliance.
- UUID, endpoint count, cluster shape, and pairing identity remain unchanged.

Run the focused tests, then `npm run verify`. No live account/device access is
needed for these checks.

### 5. Household acceptance — separately scheduled live validation

After implementation and review, install through the normal development-build
workflow and restart only the EcoFlow child bridge with explicit authorization.
Do not reset or recommission the bridge.

Verify on the actual Apple Home version:

- Stored device shows Off without a persistent accessory/home-summary error.
- Missing temperature/humidity do not become a fake zero, stale room reading,
  or a new persistent fault indication.
- Trying a control can produce a transient rejection, but leaves no persistent
  error or changed state. Apple Home cannot be promised to hide/disable these
  controls merely because the plugin rejects their commands.
- Room, scenes, automations, and endpoint count survive restart and storage.
- Physical power-on updates current state read-only; storage stays checked and
  commands remain rejected. No saved command is replayed and no plugin-driven
  power-on occurs.
- Unchecking storage, saving, and restarting restores normal controls once
  fresh device state is available. Later connection loss surfaces a fault.

If Off plus null readings or rejected controls still produce a persistent Home
error, the UX goal has not passed. Reassess the presentation; do not ship stale
readings or silently accept controls to make the test appear successful.

### 6. Documentation and rollback

Update README/config help, troubleshooting, TODO, and add a focused decision
record documenting the explicit reachability exception and return policy.
Record manual return as the selected policy in decision 0007. Household
acceptance remains outstanding; no live installation is part of implementation.

Rollback: disable Seasonal Storage and restart the child bridge. Restore the
ordinary projection without deleting an accessory, resetting a cache, or
changing pairing. Reverting the plugin build also requires removing the new
config key because the current parser rejects unknown device fields.

## Evidence and existing-solutions preflight

Apple Home summary controls are an existing partial workaround, but do not
provide a plugin-owned storage state or guarantee a non-error accessory tile:
[Apple Home status settings](https://support.apple.com/en-au/105042).

No new framework or storage-specific persistence mechanism is needed. Use
Homebridge configuration and its existing
[cache/state update APIs](https://developers.homebridge.io/homebridge/interfaces/MatterAPI.html).
Verify configuration and presentation across restart as part of acceptance.

Matter defines Reachable as physical bridged-device reachability; the opt-in
storage override is an intentional exception:
[Matter.js cluster definition](https://app.unpkg.com/@matter/types@0.16.7/files/src/clusters/bridged-device-basic-information.ts).
