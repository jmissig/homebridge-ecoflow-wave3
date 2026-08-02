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
updates, Matter command handlers, composed endpoints, direct Matter.js device
and cluster types, and a Matter `Thermostat` device with Heating, Cooling, and
Auto features. The installed Homebridge documentation explicitly permits a
bridge to expose Matter alongside or instead of HAP.

Matter's thermostat model includes system modes absent from HAP
`HeaterCooler`, including Fan Only, Dry, and Sleep. This matches the WAVE 3
better than preserving HAP and adding several synchronized companion services.

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

## Alternatives rejected

- **Permanent HAP and Matter support:** rejected because it doubles the
  presentation, state-sync, testing, and support surface before a first
  release.
- **Stay on HAP and emulate missing modes with companion services:** rejected
  because Matter has the more honest HVAC model and is the accepted direction.
- **Prototype both Matter HVAC device types before implementation:** rejected;
  proceed directly with the Matter `Thermostat` model and adapt within Matter
  if Homebridge's friendly wrapper is too narrow.
