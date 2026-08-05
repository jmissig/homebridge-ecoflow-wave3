# Defer Matter Auto mode

Date: 2026-08-02

## Decision

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

## Consequences

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
