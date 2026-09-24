# 0007 — Explicit Seasonal Storage with manual return

Date: 2026-09-24. Product decision: Julian. Implementation: fixture/runtime
tested separately; household Apple Home acceptance remains outstanding.

## Decision

Add `devices[].seasonalStorage`, a per-device boolean defaulting to false.
The Homebridge checkbox is authoritative and persists through normal config
storage. Save and restart the EcoFlow child bridge to apply changes.

While enabled, block all external controls regardless of device availability.
If authoritative operational state is unavailable, keep the existing Matter
endpoint and present virtual Off, stopped fan, and null temperature, humidity,
and power. Preserve valid mode/setpoint preferences and firmware metadata.
If fresh device state returns, display actual state read-only; do not uncheck
or silently consume the setting. Only manual exit restores normal controls,
and those still require fresh current-session device state.

This is an explicit exception to the physical reachability rule in decision
0003: a stored offline appliance is presented as reachable to avoid persistent
No Response. Controller availability remains truthful. Synthetic presentation
does not advance `lastConfirmedAt`; clear that timestamp when caching virtual
Off so it cannot receive ordinary startup freshness grace after manual exit.

The storage option changes neither UUID nor endpoint shape. Do not bump the
Matter accessory shape version, unregister/recreate an endpoint, or reset
pairing to enter/exit storage. No additional tiles or manufacturer clusters.

## Return policy and alternatives

Julian chose manual return because it keeps the visible Homebridge setting
accurate. Automatic return would either leave a misleading checkbox or require
configuration mutation/hidden episode state. No episode latch is implemented.
Automatic inference from absence was rejected because ordinary network faults
should remain faults when storage is disabled.

Apple Home's summary controls are a partial alternative, but do not provide a
storage policy for the actual accessory. See
[Apple's status settings](https://support.apple.com/en-au/105042).
The override is not standard Matter seasonal-storage support; Matter defines
Reachable in terms of the actual bridged device:
[Matter.js definition](https://app.unpkg.com/@matter/types@0.16.7/files/src/clusters/bridged-device-basic-information.ts).

## Boundaries and acceptance

- No power-off, wake, or other device-control command is sent for storage.
- Keep shared cloud subscriptions and read-only latestQuotas discovery.
  Stored units retry missing authority no more frequently than every five
  minutes; active units retain their existing cadence. Skip the action-71
  startup full-display request for stored units.
- Stop or failed refresh publication can still require transport cleanup.
  Successful telemetry completion must not abort a pending publication on
  shared MQTT merely to cancel its future retry timer.
- Reject controls before staging and execution. Never replay rejected intent.
  Configuration changes take effect in a new child-bridge process, so no
  mutable runtime storage mode or storage-generation mechanism is needed.
- Rollback reconciles current availability, and Matter update deduplication
  advances only after read-back confirms delivery.
- Homebridge must remain running. Account/network faults remain in its logs.
  Apple Home controls may remain visible and show a transient rejection.
- Real Apple Home acceptance must demonstrate no persistent tile/summary
  error, no bogus readings, unchanged pairing/room/scenes, read-only wake,
  manual exit, and normal fault reporting afterward. In-process Matter tests
  do not prove Apple Home rendering or real-device cloud behavior.

Rollback: disable the option and restart the child bridge. To revert to an
older plugin build, remove the new config key (older validation rejects it).
No removal/recommissioning is required by this feature.
