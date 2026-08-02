# Decision 0003: Publish the WAVE 3 through Matter only

- **Date:** 2026-08-01
- **Status:** accepted
- **Decision owner:** Julian
- **Source:** [Discord project thread · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533330071866310766)

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
- The HAP presentation class, cached HAP accessories, HAP tests, HAP package
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
success timeout: the cloud session remains stopped until the endpoint exists,
while shutdown joins endpoint appearance and confirmed removal for a
registration already dispatched. Homebridge retains ultimate process-level
shutdown authority if its internal registration operation never settles.

Homebridge 2.2.1 also caches `MatterAccessory.firmwareRevision` without mapping
it onto the live `BridgedDeviceBasicInformation` server. The plugin therefore
reports WAVE firmware directly through that standard Matter cluster's
`softwareVersion` and `softwareVersionString` attributes after confirming that
the asynchronously registered endpoint is available.

Homebridge's generic handler wrappers replace required Room Air Conditioner
behavior features, including OnOff Dead Front Behavior and Fan Control Multi
Speed. The plugin therefore binds its feature-preserving behaviors directly to
the existing WAVE controller. OnOff commands, thermostat modes and setpoints,
setpoint raise/lower, and settled fan writes all wait for the controller's
acknowledgement-plus-observed-state confirmation. Controller failures use
standard Matter status errors, and failed asynchronous attribute writes queue a
restoration of the last confirmed snapshot.

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
