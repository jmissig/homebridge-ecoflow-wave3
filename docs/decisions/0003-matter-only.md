# Decision 0003: Publish the WAVE 3 through Matter only

- **Date:** 2026-08-01
- **Status:** accepted
- **Decision owner:** Julian
- **Source:** [Discord project thread · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533330071866310766)

Implementation status: completed through the Matter-only source cleanup on
2026-08-02.

## Decision

Replace the current HAP `HeaterCooler` presentation with a Matter-only
presentation before the first release. Do not maintain HAP and Matter adapters
in parallel as supported product surfaces.

The EcoFlow child bridge will enable Matter and disable HAP. Other Homebridge
bridges and child bridges may remain HAP-only; Matter is configured per bridge.

## Evidence

Homebridge 2.2.1 exposes an opt-in `api.matter` plugin API per bridge, including
platform accessory registration, cached accessory updates, cluster-state
updates, Matter command handlers, composed endpoints, and direct Matter.js
device and cluster types. Its raw `RoomAirConditioner` requirements include
On/Off, Thermostat, Fan Control, temperature measurement, and relative-humidity
measurement servers. The installed Homebridge documentation explicitly permits
a bridge to expose Matter alongside or instead of HAP.

Matter's thermostat model includes system modes absent from HAP
`HeaterCooler`, including Fan Only, Dry, and Sleep. This matches the WAVE 3
better than preserving HAP and adding several synchronized companion services.

## HVAC mapping contract

Use a customized Matter `RoomAirConditioner` endpoint, not the narrower
Homebridge convenience wrapper unchanged. Construct it from Homebridge's
exported low-level `devices.RoomAirConditionerDevice` and
`devices.RoomAirConditionerRequirements`, enabling Heating, Cooling, AutoMode,
and FanControl.

Power and active HVAC mode are separate Matter concerns:

- Off -> `OnOff.onOff = false`
- Powered -> `OnOff.onOff = true`
- Auto -> `Thermostat.systemMode = Auto` (`0x01`)
- Cool -> `Thermostat.systemMode = Cool` (`0x03`)
- Heat -> `Thermostat.systemMode = Heat` (`0x04`)
- Fan Only -> `Thermostat.systemMode = FanOnly` (`0x07`)
- Dry -> `Thermostat.systemMode = Dry` (`0x08`)
- Sleep -> `Thermostat.systemMode = Sleep` (`0x09`)

The first five mappings were provided as implementation guidance by Julian and
verified against the Matter enum shipped with Homebridge 2.2.1. Dry and Sleep
are also present in that same enum. [told: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533331816684196001)

Although `Thermostat.SystemMode.Off` (`0x00`) exists, the Room Air Conditioner
device's `OnOff` cluster remains the canonical power surface. Retain the last
confirmed active mode while off unless observed controller behavior requires a
different normalization.

## Consequences

- The existing EcoFlow authentication, MQTT, protobuf, normalized state,
  controller confirmation, rate limiting, and app-coexistence code remains.
- The HAP presentation class, HAP tests, HAP package
  metadata, and HAP-specific error mapping will be deleted during migration.
- Existing Apple Home pairing, room assignment, scenes, and automations will
  not migrate. The old HAP child bridge must be unpaired and the Matter child
  bridge paired with its new QR code.
- The plugin will require Matter to be enabled on its child bridge and will
  fail clearly rather than silently falling back to HAP.
- Homebridge's Matter implementation is uncertified; Apple Home may show an
  uncertified-accessory warning during commissioning.

## Homebridge 2.2.1 compatibility notes

The 2.2.1 `updatePlatformAccessories` implementation replaces Homebridge's
internal live accessory record with the plugin's plain public object, dropping
the private endpoint needed by later `updateAccessoryState` calls. Until that
upstream path is fixed, this plugin reconciles name and context while
re-registering cached accessories and does not call the unsafe metadata-update
method.

The bridged `registerPlatformAccessories` and `updateAccessoryState` methods in
2.2.1 resolve after emitting internal events, before endpoint construction or
attribute mutation is complete. The plugin therefore treats both promises as
dispatch acknowledgements only: it polls `getAccessoryState` for endpoint
readiness after registration and reads every emitted attribute set back before
considering a snapshot update complete. Shutdown stops launch from creating
additional bindings and drains this confirmed-update chain before returning.
Same-UUID shape changes also wait for confirmed endpoint disappearance before
dispatching their replacement registration. Registration readiness has no
success timeout while the platform is active: the cloud session remains
stopped until the endpoint exists. Shutdown cancels that readiness wait and
makes a bounded best effort to remove a registration already dispatched, so a
dropped Homebridge event cannot hang child-process shutdown indefinitely.
Homebridge retains ultimate process-level authority over a registration that
materializes only after that bounded cleanup window.

Homebridge 2.2.1 also caches `MatterAccessory.firmwareRevision` without mapping
it onto the live `BridgedDeviceBasicInformation` server. The plugin therefore
reports WAVE firmware directly through that standard Matter cluster's
`softwareVersion` and `softwareVersionString` attributes after confirming that
the asynchronously registered endpoint is available.

The accessory context also records when this bridge last received
authoritative WAVE state. On restart, cached Matter values remain presented for
at most 15 minutes, but control stays blocked until the current MQTT generation
supplies authoritative state. Missing or expired cache sets the standard
`BridgedDeviceBasicInformation.reachable` attribute to false; fresh state sets
it true and renews the timestamp. Explicit offline or account/session-error
evidence becomes unreachable immediately rather than consuming the grace
period. [Decision: Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533514045766897795)

After startup has established current-generation state, the controller allows
five minutes without recognized authoritative telemetry before marking the
device stale. Household logs show that the WAVE's normal full display upload
arrives approximately every two minutes; the prior two-minute deadline raced
that upload and briefly toggled reachability. Five minutes tolerates one
missed upload plus delivery jitter without weakening per-command confirmation.
[Decision: Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533535457453932654)

Homebridge's generic handler wrappers replace required Room Air Conditioner
behavior features, including OnOff Dead Front Behavior and Fan Control Multi
Speed. The plugin therefore binds its feature-preserving behaviors directly to
the existing WAVE controller. OnOff and setpoint-raise/lower are Matter
commands, so they await the controller's acknowledgement-plus-observed-state
confirmation and return standard Matter status errors. Thermostat mode,
thermostat setpoint, and fan controls are standard writable Matter attributes.
Matter.js 0.17.6 commits those synchronous writes before an asynchronous cloud
round trip can finish; the plugin validates them synchronously, tracks and
drains the confirmed controller operation, and logs plus restores the last
confirmed snapshot if EcoFlow later rejects or times out. It does not claim
that such attribute failures can be returned transactionally by this runtime.

The Thermostat cluster advertises the WAVE's actual 16–30°C range for both
heating and cooling. With the standard minimum deadband set to zero, crossing
one setpoint moves its inactive companion so the Matter transaction remains
valid; the same rule applies to `SetpointRaiseLower`. Confirmed command
snapshots are reconciled only after Matter.js releases the interactive command
transaction, avoiding collisions with Homebridge 2.2.1's deferred state
updates.

The five WAVE fan levels map to 20/40/60/80/100 percent and discrete speeds
1–5. Standard Low/Medium/High fan modes use the Matter sequence's percentage
buckets, while every accepted setting write updates `FanMode`,
`PercentSetting`, and `SpeedSetting` coherently. Null setting writes mean no
change. Power-off cancels a pending airflow write, and coalescing back to the
confirmed speed emits no cloud command.

All Matter command work enters one adapter-level queue before it reads the
latest confirmed WAVE snapshot and derives a command payload. This makes rapid
power, mode, and setpoint requests linearizable rather than merely serializing
already-stale command objects in the controller. Direct thermostat writes are
coalesced for one Matter transaction so a crossing write and its automatically
adjusted companion become one confirmed WAVE range command. A power-off
request invalidates pending and already-queued fan work immediately, before it
waits for Homebridge's deferred state-update chain.

Sleep is represented by the standard Matter Sleep system mode. Eco and Boost
remain unexposed: Homebridge 2.2.1's Room Air Conditioner endpoint does not
offer a stable standard preset/economy surface that preserves the required
features, and this project will not add manufacturer-specific clusters merely
to create those controls. Selecting a normal active system mode clears an
observed Sleep, Eco, or Boost submode before changing the WAVE operating mode.

## Alternatives rejected

- **Permanent HAP and Matter support:** rejected because it doubles the
  presentation, state-sync, testing, and support surface before a first
  release.
- **Stay on HAP and emulate missing modes with companion services:** rejected
  because Matter has the more honest HVAC model and is the accepted direction.
- **Prototype both Matter HVAC device types before implementation:** rejected;
  proceed directly with a customized Matter `RoomAirConditioner` endpoint and
  use Homebridge's exported low-level device requirements where its friendly
  wrapper is narrower.
