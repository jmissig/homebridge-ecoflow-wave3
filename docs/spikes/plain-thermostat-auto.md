# Plain Thermostat Auto spike

## Question

Does Apple Home write `Thermostat.SystemMode = 1` (Auto) when the WAVE 3 is
presented with a fresh identity as a plain Matter Thermostat instead of a Room
Air Conditioner?

## Disposable topology

The spike leaves the existing Room Air Conditioner endpoint and UUID unchanged.
For each configured WAVE it adds one endpoint named `<device name> Auto Test`
with:

- Matter device type `Thermostat` (`0x0301`)
- Heating, Cooling, and Auto features
- the same 16–30°C limits, dual setpoints, and deadband metadata as the primary
  endpoint
- a distinct deterministic UUID and bridged serial number
- no OnOff, FanControl, humidity, electrical-power, or thermostat-UI cluster

Both endpoints share one EcoFlow controller and cloud session. The diagnostic
endpoint has its own Matter binding but receives the same authoritative WAVE
snapshots.

## Scope boundary

Only test mode changes while the WAVE is already powered. The diagnostic
endpoint deliberately does not implement Thermostat Off semantics, so Off→Auto
would test a second variable and is outside this spike.

## Live procedure

1. Install this branch and restart the EcoFlow child bridge.
2. Confirm that both the existing WAVE endpoint and the new `Auto Test`
   thermostat register. The existing endpoint must retain its UUID and room.
3. In the EcoFlow app, power the WAVE on in Cool and wait for fresh authoritative
   state.
4. In Apple Home, select Auto on the `Auto Test` thermostat exactly once.
5. Capture the raw incoming Matter `systemMode`, the plugin semantic command,
   EcoFlow acknowledgement, and subsequent authoritative WAVE state.
6. Leave the EcoFlow app closed and wait 30–60 seconds for any delayed Cool
   replay.
7. Repeat once from powered Heat. If useful, repeat from an older Apple OS.

Do not add the diagnostic endpoint to automations or use its Off control.

## Verdict

- **Validated workaround:** Apple writes `SystemMode = 1`, the plugin sends one
  WAVE mode-5 command, and the WAVE restores its saved Auto range without a
  synthetic setpoint write.
- **Room Air Conditioner suspect:** the plain endpoint writes `1` while the
  existing Room Air Conditioner continues to write `3`. A later fresh-identity
  Room Air Conditioner clone can separate device type from cached capabilities.
- **Apple Auto defect remains:** the fresh plain endpoint also writes `3`.
- **Partial:** Apple omits Auto, sends conflicting writes, or endpoint
  registration prevents a clean protocol trace.

## Cleanup

After the observation, reinstall `main` and restart the child bridge. The normal
platform does not include the spike UUID, so its stale-accessory reconciliation
will unregister the diagnostic endpoint. The primary WAVE UUID is never changed.
