# Architecture comparison: blinded ideal vs current plugin

This review compares the independently produced
[blinded greenfield proposal](architecture-blinded-proposal.md) with the actual
plugin at the pre-hardening review baseline `cdfcde6`, then records the five
changes implemented from that review. The proposal saw protocol behavior and
product constraints, but not this repository, its prior decisions, or its
source layout.

## Verdict

The current implementation landed on the same architectural center of gravity
as the blinded design:

- a Homebridge 2.2.1 Matter-only dynamic platform;
- one shared account/cloud session;
- one state-and-command owner per configured WAVE 3;
- pure typed protobuf encoding/decoding below the controller;
- confirmed normalized state between EcoFlow and Matter;
- generation-aware reconnect handling;
- bounded command serialization and accumulated evidence;
- Homebridge cache used only for recent presentation continuity;
- no generic EcoFlow framework.

The differences are mostly about **how explicitly and finely those
responsibilities are separated**, not competing models of the system. A
greenfield rewrite is not justified. Several seams should be tightened as the
pre-release hardware phase settles.

## Current implementation map

```text
Homebridge initializer
  -> EcoFlowWave3Platform
       -> config validation and Matter cache reconciliation
       -> one shared EcoFlowCloudSession
            -> HTTPS auth/certification
            -> MQTT transport, subscriptions, generations, refresh retry
       -> one Wave3Controller per configured device
            -> normalized display/runtime state
            -> authority, freshness, command queue, confirmation evidence
       -> one Wave3MatterAccessory binding per device
            -> RoomAirConditioner behavior classes and cluster projection
            -> Apple Home write staging, coalescing, and Matter reconciliation

Wire path:
  MQTT bytes -> Wave3 codec -> typed routed event -> controller state
             -> Matter projection
Matter path:
  Matter write -> semantic WAVE intent planner -> Wave3Command
               -> controller -> codec -> MQTT bytes
```

Primary source boundaries:

- [`src/platform.ts`](../src/platform.ts) — Homebridge lifecycle, configuration,
  cache reconciliation, and composition root.
- [`src/ecoflow/auth.ts`](../src/ecoflow/auth.ts),
  [`http.ts`](../src/ecoflow/http.ts), and
  [`mqtt.ts`](../src/ecoflow/mqtt.ts) — replaceable infrastructure seams.
- [`src/ecoflow/session.ts`](../src/ecoflow/session.ts) — shared cloud session,
  connection generations, decode-once routing, refreshes, and lifecycle
  cancellation.
- [`src/wave3/sessionPort.ts`](../src/wave3/sessionPort.ts) — inward-facing
  controller session and typed inbound-event contract.
- [`src/wave3/domain.ts`](../src/wave3/domain.ts) — Homebridge-free normalized
  state, commands, results, and availability.
- [`src/wave3/codec.ts`](../src/wave3/codec.ts) — protobuf/JSON boundary and
  merge-safe display updates.
- [`src/wave3/controller.ts`](../src/wave3/controller.ts) — per-device state
  owner and command-confirmation engine.
- [`src/wave3/intentPlanner.ts`](../src/wave3/intentPlanner.ts) — pure WAVE
  destination-profile and setpoint planning.
- [`src/matter/`](../src/matter) — endpoint behavior construction, control
  registry, snapshot projection, constants, context, and cache policy.
- [`src/matterAccessory.ts`](../src/matterAccessory.ts) — per-endpoint binding,
  Apple Home write coordination, and confirmed Matter reconciliation.

## Where the designs align

### Narrow product scope

Both designs reject a generic EcoFlow hierarchy. Configuration is explicit and
WAVE 3-specific, and all domain names describe WAVE behavior rather than an
imagined universal device model.

### Shared cloud session, independent device authority

The platform creates one `EcoFlowCloudSession` and one `Wave3Controller` per
configured serial. This matches the blinded recommendation: account transport
is shared, while generation state, freshness, saved profiles, and pending
commands remain device-local.

### Contemporary Matter boundary

The current plugin uses Homebridge 2.2.1's Matter API and a customized Room Air
Conditioner endpoint. There is no legacy HAP compatibility layer. Matter reads
come from local snapshots, and writes become typed WAVE commands rather than
network activity embedded in attribute reads.

### Protocol isolation

Generated protobuf types remain below the handwritten codec. Neither the
domain types nor the Matter adapter handles raw protobuf fields or MQTT topics.
The codec is directly fixture-tested.

### Authoritative delta reduction

`Wave3Controller` owns a merge-safe display accumulator and separately retains
operational power/mode and per-mode saved parameters. It rejects old sequences
and old connection generations. Runtime telemetry and firmware are stored
separately from control state.

### Conservative command confirmation

The controller serializes commands, records a fresh baseline, correlates more
than sequence alone, accumulates split acknowledgements and later display
evidence, distinguishes explicit failure from unconfirmed timeout, and never
changes authoritative state merely because MQTT accepted a publish.

### Bounded lifecycle and test seams

HTTP and MQTT are behind interfaces. The session and controller use abort
controllers, bounded deadlines, idempotent stop paths, and injected controller
clock/scheduler functions. Tests cover authentication, reconnect generations,
shutdown at in-flight boundaries, confirmation replay, Matter behavior, and
platform cleanup without live hardware.

### WAVE-aware Matter behavior

The Matter adapter preserves revisioned thermostat intent, wakes an off
appliance, then confirms power, mode, and active target/range as separate
steps. It re-plans from the latest authoritative snapshot between steps,
coalesces slider writes, suppresses duplicates, preserves fractional Celsius,
enforces the observed four-degree Auto range internally, and distinguishes
Sleep/Night from a timer. Newer controller intent supersedes unfinished steps;
power-off cancels queued thermostat and fan work.

## Differences and their disposition

### 1. Callback-driven controller vs explicit actor mailbox

**Blinded ideal:** one bounded FIFO mailbox containing every observation,
intent, timer, reconnect, and shutdown event.

**Current:** `Wave3Controller` is actor-like but not implemented as a literal
mailbox. Inbound MQTT callbacks reduce state synchronously; commands use a
serialized Promise tail; timers and session events enter through explicit
handlers.

**Assessment:** justified simplification for a single-threaded Node process
whose inbound reducers do not await. The controller is already the sole owner
of device authority and permits only one pending command. A mailbox framework
would currently add machinery without changing observable ordering. Revisit
only if inbound processing becomes asynchronous, queues need measurable
backpressure, or more independent event sources appear.

### 2. Matter-specific staging and WAVE intent planning are now separated

**Blinded ideal:** the actor/application layer owns semantic intent planning,
including destination-mode profiles and write coalescing.

**Current:** `Wave3MatterAccessory` retains Apple Home's revisioned staged
writes, Matter transaction guards, confirmed-step coordination, and
debounce/settling timing. The pure `wave3/intentPlanner.ts` owns active
target/range planning, fractional setpoint preservation, Auto range
normalization, and semantic no-op decisions. Confirmed WAVE mode profiles stay
in controller snapshots and are never inferred from inactive Matter companion
setpoints.

**Assessment:** aligned with the blinded ideal at the useful seam. Apple Home
ordering remains presentation policy; WAVE profile semantics are independently
testable without Homebridge or Matter.js.

### 3. Inbound payloads are decoded once

**Blinded ideal:** validate and decode once, then pass immutable normalized
events to the actor.

**Current:** the cloud session strictly routes and decodes each inbound payload
once, reuses that result for bounded diagnostics and refresh decisions, and
passes an immutable typed event with generation and payload length to the
controller. Raw inbound bytes do not cross the controller port.

**Assessment:** aligned. Refresh lifecycle remains in the session while state
authority remains in the controller, and both consume the same decode result.

### 4. Operational authority freshness is separated from telemetry freshness

**Blinded ideal:** every field carries generation, source, receive ordinal,
monotonic observation time, and authority metadata.

**Current:** display merging remains field-preserving and generation-aware.
Only updates containing operational control evidence renew the five-minute
control-authority window. Sensor, saved-profile-only, and runtime/device-info
deltas update their own presentation state without postponing operational
staleness.

**Assessment:** the release-relevant risk from the blinded review is resolved:
a temperature/runtime stream cannot conceal missing control uploads. The
controller deliberately uses an operational category timestamp rather than
attaching a full evidence object to every scalar; that smaller model matches
the commands and evidence currently supported. Per-field monotonic metadata
remains an optional refinement if future commands need independently aging
profile baselines.

### 5. Persistence uses Homebridge Matter context, not a repository port

**Blinded ideal:** an explicit atomic persistence adapter with migrations and
per-field evidence times.

**Current:** stable identity and a small presentation cache live in the
Homebridge Matter accessory/context: schema version, temperature-source shape,
last system mode, last confirmation time, and firmware. Live authority and
credentials are never persisted.

**Assessment:** justified. Homebridge already owns cached accessory identity
and lifecycle, and the plugin deliberately persists only presentation
continuity rather than reconstructing domain authority. Adding a second store
would create migration and atomicity work without a current product need. An
explicit store becomes worthwhile only if persisted data outgrows accessory
context or needs independent migrations.

### 6. Restored presentation remains reachable briefly

**Blinded ideal:** restore presentation but mark it unreachable until current
authority returns.

**Current:** a recent confirmed presentation may remain visible/reachable for
up to 15 minutes during restart or reconnect, while the controller rejects all
writes until current-generation authority returns. Explicit offline/account
errors bypass the grace period immediately.

**Assessment:** deliberate product difference. The current policy prioritizes
Apple Home continuity during the WAVE's sometimes minute-long startup state
acquisition and prevents routine No Response flicker. The safety boundary is
still strict because cached state is never a command baseline. The cost is
that Matter reachability temporarily means “recently observed and presented,”
not “currently writable.” This trade-off should remain documented and tested.

### 7. Matter callback plumbing uses an encapsulated registry

**Blinded ideal:** adapter-local intent ports with no shared mutable state.

**Current:** custom Matter behavior classes are instantiated by the running
Matter.js runtime, so a focused `matter/controlRegistry.ts` connects endpoint
IDs to per-accessory controls and consumes expected internal attribute writes.
It rejects duplicate registration, and release clears both controls and desired
write guards.

**Assessment:** justified and now isolated as presentation plumbing rather than
device authority. Focused tests cover expected-write consumption, duplicate
registration, and release cleanup.

### 8. Diagnostics are safe strings rather than structured domain events

**Blinded ideal:** a typed semantic event sink plus counters.

**Current:** modules depend on a small logger interface and emit bounded,
redacted semantic strings. Sanitizers and tests prevent secrets, identifiers,
topics, and raw payloads from escaping.

**Assessment:** justified for the current plugin size and Homebridge's logging
surface. A logging framework is unnecessary. Typed internal diagnostic events
would become useful if counters, alternate sinks, or machine-readable support
bundles are added; redaction should then occur before rendering, not after.

### 9. Matter and cross-layer ownership seams are explicit

**Blinded ideal:** separate modules for endpoint construction, projection,
intent planning, reducer, authority, command planning, confirmation, topics,
and individual codecs.

**Current:** controller-session contracts live in `wave3/sessionPort.ts`, Matter
context lives beside its cache policy, and neither lower layer imports those
types from infrastructure or the platform composition root. The former Matter
monolith is split into device behavior construction, registry, projection,
cache policy, constants/context, and the remaining binding/write coordinator.
The session, codec, controller, and binding remain substantial cohesive modules
rather than being fragmented to mirror every greenfield filename.

**Assessment:** the hardening work improved dependency direction and reviewable
ownership without adding a framework or speculative abstraction hierarchy.
Further splitting should be driven by a concrete changing responsibility, not
file length alone.

### 10. Cancellation scopes are distributed rather than one root tree

**Blinded ideal:** a root cancellation scope with generation-bound actor child
scopes.

**Current:** platform launch/shutdown promises, session lifecycle and setup
abort controllers, public-operation controllers, controller publication
controllers, timers, and Matter binding stop paths are explicit but
distributed.

**Assessment:** behaviorally aligned and extensively tested. A single
cancellation framework would not currently reduce enough complexity to justify
a rewrite. Preserve the explicit local scopes unless ownership bugs emerge.

### 11. Ordering uses device sequences and epoch clocks, not a receive ordinal

**Blinded ideal:** monotonic receive ordinal/time accompanies every normalized
observation; wall time is reserved for persistence/display.

**Current:** device protobuf sequences order display/runtime packets and
connection generations reject old sessions. Injected `Date.now`-style clocks
drive freshness and cache age.

**Assessment:** device sequence plus generation is the strongest observed wire
ordering evidence. A local receive ordinal would still clarify diagnostics and
tie-breaking, while a monotonic clock would make live deadlines immune to wall
clock adjustments. This is a small robustness improvement, not a reason to
replace the state model.

## Hardening disposition

The ordered implementation and verification sequence is tracked in the
[architecture hardening plan](architecture-refactor-plan.md).

The five before-release ownership changes identified by the blinded review are
implemented. Automated verification covers their dependency and behavioral
contracts. The remaining acceptance item is deployment of the integrated build
and repetition of the documented Home/app hardware smoke path, especially the
unattended five-minute operational-category freshness observation.

### Useful but not release-blocking

- Add monotonic receive ordinals and live-deadline time.
- Introduce typed diagnostic events only if counters/support bundles justify
  them.
- Split codec and controller policy helpers along existing tests.
- Add model/property tests for generation and authority invariants after the
  reducers become smaller.

### Explicitly not recommended now

- Do not rewrite the plugin into a new actor framework.
- Do not add a generic dependency-injection, state-management, retry, or
  persistence framework.
- Do not create a generic EcoFlow SDK.
- Do not replace Homebridge's accessory cache with a second database.
- Do not change the confirmed command or Matter product model merely to match
  the blinded proposal's vocabulary.

## Final judgment

Blinding did not reveal a fundamentally different architecture. It independently
reconstructed nearly all of the important choices already present: narrow
scope, shared account transport, per-device state ownership, generation-aware
delta reduction, conservative accumulated command evidence, confirmed Matter
projection, and bounded cached presentation.

The comparison revealed five concrete ownership improvements; all five are now
implemented without changing the product model. The remaining deviations are
proportional simplifications or deliberate Homebridge UX trade-offs and can be
justified without special pleading.
