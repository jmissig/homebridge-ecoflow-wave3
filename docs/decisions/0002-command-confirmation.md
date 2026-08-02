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
5. A newer display upload, received after that acknowledgement, contains every
   command-specific field and confirms the requested normalized state.

A state upload received before acknowledgement, or an unrelated partial
update that merely leaves a matching cached value in place, cannot confirm the
command. Duplicate and older telemetry sequences do not overwrite newer
state. A positive acknowledgement triggers a state-refresh request.

Broker publication completion and the device acknowledgement can arrive in
either order. The controller retains an early matching acknowledgement and
qualifying later display evidence, but does not report success unless MQTT
publication subsequently succeeds. Publication failure still wins.
The WAVE 3 may omit one or more successfully applied fields from positive
acknowledgements for a composite write. Matching acknowledgement fragments are
accumulated, but authoritative later display state may confirm omitted fields.
Semantically identical duplicate acknowledgements are ignored; contradictory
acknowledgements with the same sequence are treated as foreign traffic and do
not contribute evidence.

Publication failure, explicit/ambiguous acknowledgement, timeout, disconnect,
or shutdown returns a typed failure. Commands are serialized so climate mode,
target, range, fan, and submode writes cannot race. Cached confirmed state is
never changed optimistically. One command deadline covers publication,
acknowledgement, and observed-state confirmation; timeout or shutdown aborts
an in-flight publication so it cannot hold the command queue indefinitely.

## Consequences

- This policy remains fail-closed while accommodating the household device's
  observed partial acknowledgements for composite writes.
- `configOk` absence is treated as rejection until hardware proves another
  interpretation.
- Exact sequence correlation and 32-bit telemetry ordering remain protocol
  inferences. Phase 6 must validate them before commands are enabled against
  the household WAVE 3.
- HomeKit can distinguish publication failure, rejection, timeout,
  disconnect, and shutdown without exposing transport details.
