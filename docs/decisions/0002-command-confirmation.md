# Decision 0002: Command confirmation policy

- Date: 2026-07-28
- Status: accepted for fake-backed implementation; hardware validation pending

## Context

MQTT QoS 1 confirms broker delivery, not device acceptance. The pinned WAVE 3
protocol also exposes configuration-write acknowledgements and display-state
uploads, but it does not demonstrate the complete semantics of `configOk`,
`actionId`, or acknowledgement sequence correlation.

HomeKit must not rubber-band to optimistic values or report a command as
successful merely because MQTT publication completed.

## Decision

The controller serializes commands and considers one successful only after:

1. MQTT publication completes.
2. A configuration-write acknowledgement arrives with the same envelope
   sequence as the command.
3. `configOk` is explicitly `true`.
4. The acknowledgement echoes at least one value consistent with the command.
5. A newer command-relevant display upload arrives after the first matching
   acknowledgement.
6. The merged authoritative state matches the complete requested command, and
   every requested field is supported by at least one of:
   - fresh current-generation state that already matched before publication;
   - a matching same-sequence acknowledgement fragment; or
   - matching evidence accumulated across later display deltas.

A state upload received before acknowledgement, or unrelated temperature and
humidity telemetry that merely leaves matching state in place, cannot confirm
the command. Duplicate and older telemetry sequences do not overwrite newer
state. A positive acknowledgement triggers a state-refresh request.

Broker publication completion and the device acknowledgement can arrive in
either order. The controller retains an early matching acknowledgement and
qualifying later display evidence, but does not report success unless MQTT
publication subsequently succeeds. Publication failure still wins.
The WAVE 3 may omit one or more successfully applied fields from positive
acknowledgements for a composite write. Matching acknowledgement fragments and
later display-field evidence are accumulated independently; no single packet
must restate the complete transaction. Fields already satisfied by fresh
pre-command state remain valid evidence because the writes are idempotent.
Semantically identical duplicate acknowledgements are ignored; contradictory
acknowledgements with the same sequence are treated as foreign traffic and do
not contribute evidence.

This covers both household composite-startup shapes observed so far: separate
positive power, target, and mode acknowledgements followed by a power-only
display upload; and a power-only acknowledgement followed by `sleepState=0`
when the saved Cool mode and target already matched the requested values.

Publication failure, explicit/ambiguous acknowledgement, confirmation timeout,
disconnect, or shutdown returns a typed unsuccessful result. Commands are
serialized so climate mode, target, range, fan, and submode writes cannot race.
Cached confirmed state is never changed optimistically. One command deadline
covers publication, acknowledgement, and observed-state confirmation; timeout
or shutdown aborts an in-flight publication so it cannot hold the command queue
indefinitely.

Debug diagnostics describe this lifecycle semantically: the normalized
command, publication acceptance, acknowledged and still-waiting fields,
observed-state confirmation, and the final typed outcome. They deliberately do
not include serial numbers, account identifiers, MQTT topics, credentials, or
raw packet bytes. A deadline without explicit rejection is logged as
`unconfirmed:timeout`, not as a device command failure.

## Consequences

- This policy remains fail-closed while accommodating the household device's
  split acknowledgements, saved per-mode state, and incremental display
  uploads.
- `configOk` absence is treated as rejection until hardware proves another
  interpretation.
- Exact sequence correlation and 32-bit telemetry ordering remain protocol
  inferences. Phase 6 must validate them before commands are enabled against
  the household WAVE 3.
- HomeKit can distinguish publication failure, rejection, timeout,
  disconnect, and shutdown without exposing transport details.
