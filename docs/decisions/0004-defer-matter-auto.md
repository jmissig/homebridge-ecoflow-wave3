# Matter Auto mode interoperability

Date: 2026-08-02
Superseded in part: 2026-08-08

## Current decision

Advertise Matter Thermostat Auto again using the completed staged-intent and
authoritative-profile coordination model. A mode-only Auto write sends only
WAVE mode `5`; after confirmation, the WAVE's saved lower and upper thresholds
are projected back into Matter. Only explicit controller setpoint writes may
replace that saved range.

Keep Matter's global `MinSetpointDeadBand` at zero because a four-degree global
constraint would also restrict ordinary Heat and Cool companion setpoints.
Enforce the WAVE-specific 4°C Auto minimum in the semantic planner within the
16–30°C device bounds. Replace the schema-v4 Heat/Cool-only endpoint with the
schema-v5 Auto-capable shape under the same UUID.

This supersedes the deferral below. It does not erase the prior Apple Home
interoperability evidence; renewed controller and hardware acceptance remains
required.

The 2026-08-08 household acceptance pass proved the WAVE-facing implementation
but not Apple Home control. Cool→Heat→Cool restored each saved WAVE profile,
and selecting Auto in the EcoFlow app produced authoritative WAVE mode `5` and
the saved 19.8–23.8°C range. Homebridge projected `SystemMode.Auto`, which the
Apple fabric accepted and Apple Home rendered as Auto. In the other direction,
however, tapping Auto in Apple Home sent a raw Matter write of
`Thermostat.SystemMode = 3` (Cool), never `1` (Auto). Off→Auto and attempts from
an older Apple OS produced the same value. The plugin therefore never received
an Auto intent to translate into WAVE mode `5`.

## Previous decision

Do not advertise the Matter Thermostat Auto feature in the first release.
Continue decoding and retaining the WAVE 3's real Auto profile internally. If
Auto is selected in the EcoFlow app, project it to Matter as Cooling at the
Auto upper threshold until controller interoperability is sufficient to expose
the real mode.

Reconsider this decision after a second Matter controller or a meaningful
Apple Home/Homebridge Matter update demonstrates both directions of the
standard contract:

1. selecting Auto writes `Thermostat.SystemMode = Auto`;
2. reporting `SystemMode = Auto` is rendered as Auto by the controller.

## Evidence

- Matter 1.1 defines `SystemMode` as a read/write attribute and defines Auto as
  device-side demand generation for heating or cooling from the two setpoints.
  [source: CSA Matter Application Cluster Specification 1.1 · 2023-05-17](https://csa-iot.org/wp-content/uploads/2023/05/matter-1-1-application-cluster-specification.pdf)
- Apple's Matter framework exposes `MTRThermostatSystemMode.auto`; there is no
  separate Apple-controller-owned Auto contract. [source: Apple Developer
  Documentation · retrieved 2026-08-02](https://developer.apple.com/documentation/matter/mtrthermostatsystemmode/auto)
- The plugin's runtime endpoint passed Matter.js conformance with Heating,
  Cooling, Auto, `ControlSequenceOfOperation=CoolingAndHeating`, and writable
  `SystemMode` before this decision.
- In two isolated household tests, Apple Home displayed Auto but did not write
  `SystemMode.Auto`; it sent power and later Cooling setpoint traffic instead.
  Apple Home also failed to render an authoritative Auto report that its Matter
  controller acknowledged. Source: household Matter diagnostics and Julian's
  narrated test · 2026-08-02

## 2026-08-08 acceptance evidence

- The saved-profile coordinator is no longer the suspected cause. Manual
  Cool→Heat→Cool transitions confirmed correctly, and a mode-only WAVE Auto
  transition retained the appliance's saved 19.8–23.8°C range. [told: Julian ·
  2026-08-08](https://discord.com/channels/1499872194610598249/1531866537185640448/1535702127895121920)
- The reverse path now works: WAVE mode `5` is projected as Matter
  `SystemMode.Auto`, acknowledged by the Apple fabric, and rendered as Auto by
  Apple Home. This supersedes the 2026-08-02 reverse-path observation above;
  only controller→WAVE Auto remains blocked. Source: household Homebridge
  Matter diagnostics and EcoFlow-app test · 2026-08-08
- At the raw Matter boundary, every Apple Home Auto selection wrote
  `SystemMode = 3` (Cool), not `1` (Auto). A focused runtime write of `1`
  traversed Homebridge and the plugin correctly and selected WAVE mode `5`, so
  there is no observed Homebridge Auto→Cool remapping. Source: household
  Homebridge Matter diagnostics · 2026-08-08
- An older Apple OS produced the same `SystemMode = 3` write and then attempted
  Auto-style paired setpoints. Because all Apple clients share the same Apple
  fabric peer, the trace cannot distinguish whether the initiating device or
  the active Home hub constructed the final write. Source: household
  Homebridge Matter diagnostics · 2026-08-08
- Home Assistant Matter Hub issue #309 contains an independent, nearly
  byte-for-byte reproduction on another matter.js Room Air Conditioner:
  Apple Home displayed Auto but wrote `SystemMode = 3`, including Off→Auto.
  [source: HAMH issue #309 · retrieved 2026-08-08](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309#issuecomment-4294985981)
- That independent AC exposed single-setpoint, device-decided `auto`, whereas
  Matter Auto is a dual-setpoint heat/cool contract. HAMH ultimately stopped
  advertising Auto for that class of device. The WAVE is materially different:
  its verified lower/upper range is genuine dual-setpoint Auto, so hiding Auto
  for single-setpoint devices is not a direct fix here. [source: HAMH climate
  documentation · retrieved 2026-08-08](https://riddix.github.io/home-assistant-matter-hub/devices/climate)

## Current interpretation and next discriminator

The failure is not unique to this plugin or to Homebridge. The evidence points
to an Apple Home interoperability problem with this Matter presentation, but
does not yet prove whether the trigger is the `RoomAirConditioner` device shape
or Apple retaining capabilities from the earlier pre-Auto endpoint.

The smallest discriminating experiment is a temporary fresh-identity endpoint
that exposes the same WAVE state and true dual setpoints as a plain Matter
Thermostat without FanControl. If Apple writes `SystemMode.Auto` there, compare
the two endpoint descriptors and decide whether losing integrated fan control
is an acceptable workaround. If it still writes Cool, preserve both raw traces
for an Apple Feedback report and test a second Matter controller.

## Consequences of the previous deferral

- Apple Home receives only the interoperable manual HVAC modes for now.
- The WAVE protocol model retains Auto mode, its saved profile, 16–30°C bounds,
  midpoint target, fractional values, and observed 4°C minimum range.
- Removing Auto also removes Matter's Auto-only `MinSetpointDeadBand`
  attribute; the WAVE-specific range rules remain in the semantic planner.
- The endpoint context schema is versioned across this feature-shape change.
  On upgrade, the platform unregisters the older cached endpoint before
  recreating the same UUID, preventing Homebridge from restoring a now-illegal
  cached `SystemMode.Auto` value without requiring the Matter bridge to be
  paired again.
- This is a controller-interoperability deferral, not a claim that WAVE Auto is
  unsupported.
