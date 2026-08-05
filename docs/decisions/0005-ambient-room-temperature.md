# Use ambient input air as room temperature

Date: 2026-08-04

## Decision

Always publish the WAVE 3 ambient/input-air sensor as Matter's local room
temperature and publish its ambient humidity. Remove the per-device
`currentTemperatureSource` configuration and the `ambient`, `outlet`, and
`none` alternatives.

The indoor supply-air/outlet temperature remains decoded telemetry. It is not
a candidate for Matter's local temperature because it measures conditioned air
leaving the appliance rather than the room air entering it.

Decision: Julian · 2026-08-04

## Consequences

- Configuration contains only each WAVE 3's name and serial number.
- Every Matter endpoint contains local temperature and relative humidity.
- The cached Matter accessory schema advances so pre-release outlet/none
  endpoint shapes are replaced under the same stable accessory UUID.
- Outlet temperature remains available to the protocol/domain layer for
  diagnostics and future non-room-temperature uses.
