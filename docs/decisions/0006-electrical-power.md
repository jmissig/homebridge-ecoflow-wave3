# Expose AC power through the existing Matter endpoint

Date: 2026-08-04

## Decision

Publish WAVE 3 display field `53` (`pow_get_ac`) as Matter
`ElectricalPowerMeasurement.ActivePower`. It represents the appliance's AC
power flow. Do not use field `777` (`pow_get_self_consume`) as a fallback:
when an add-on battery is present, self-consumption can include battery power
that is not AC import.

Declare the electrical measurement cluster on the existing Room Air
Conditioner accessory. Homebridge 2.2.1 detects that declaration, adds the
Electrical Power Measurement behavior and mandatory
`PowerTopology(TreeTopology)`, supplies the cluster's mandatory defaults, and
advertises the Electrical Sensor utility device type on the same endpoint.
A separate composed Power child is therefore unnecessary.

Matter `ActivePower` is the most recent measured active power in milliwatts;
positive values represent imported power and `null` means that power cannot
currently be measured. Convert WAVE watts to milliwatts, publish reported zero
as zero, and publish `null` when the measurement is unavailable or stale.

Decision and field semantics: Julian · 2026-08-04

## Freshness

Use one optional advanced configuration value,
`freshnessTimeoutMinutes`, defaulting to five minutes. Live evidence categories
keep independent timestamps but use this shared duration:

- operational power/mode evidence controls whether the device is presently
  authoritative and controllable;
- environmental telemetry and saved-profile evidence retain their own
  freshness rather than borrowing authority from unrelated packets;
- AC-power evidence controls whether `ActivePower` contains a measurement or
  `null`;
- evidence in one category must not renew another category or confirm commands.

Static firmware metadata, the existing ten-second command-confirmation
deadline, and the separate startup cache-restoration grace are different
mechanisms and remain outside this configuration value.

Freshness direction: Julian · 2026-08-04

## Homebridge and Matter evidence

- Homebridge 2.2.1 explicitly detects electrical measurement clusters on any
  accessory or part, applies `PowerTopology(TreeTopology)`, and advertises the
  Electrical Sensor utility device type on that same endpoint.
  [source: Homebridge 2.2.1 `AccessoryManager` and `serverHelpers` · inspected
  2026-08-04](https://github.com/homebridge/homebridge/tree/v2.2.1/src/matter)
- The installed Homebridge 2.2.1/Matter 1.6 runtime successfully composed a
  Room Air Conditioner endpoint with `powerTopology` and
  `electricalPowerMeasurement` behaviors while retaining device type `0x72`.
  [source: local no-service runtime probe · 2026-08-04]
- Matter defines `ActivePower` in milliwatts, positive for import and negative
  for export, with `null` used when a measurement is unavailable.
  [source: Matter 1.6 Electrical Power Measurement cluster as shipped with
  Homebridge 2.2.1 · inspected 2026-08-04]

## Deferred exploration

Do not initially publish cumulative energy. Later, explore integrating sampled
AC power as an explicitly estimated and persisted counter with defined gap,
restart, reset, clock-jump, and offline behavior. Prefer a real device
cumulative-energy counter if one is discovered; never label an intermittent
cloud-derived integral as accounting-grade or device-lifetime energy.
