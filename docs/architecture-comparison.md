# Architecture comparison: blinded ideal vs current plugin

This review compares the independently produced
[blinded greenfield proposal](architecture-blinded-proposal.md) with the actual
plugin at commit `cdfcde6`. The proposal saw protocol behavior and product
constraints, but not this repository, its prior decisions, or its source
layout.

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
  MQTT bytes -> Wave3 codec -> controller state -> Matter projection
Matter path:
  Matter write -> semantic Wave3Command -> controller -> codec -> MQTT bytes
```

Primary source boundaries:

- [`src/platform.ts`](../src/platform.ts) — Homebridge lifecycle, configuration,
  cache reconciliation, and composition root.
- [`src/ecoflow/auth.ts`](../src/ecoflow/auth.ts),
  [`http.ts`](../src/ecoflow/http.ts), and
  [`mqtt.ts`](../src/ecoflow/mqtt.ts) — replaceable infrastructure seams.
- [`src/ecoflow/session.ts`](../src/ecoflow/session.ts) — shared cloud session,
  connection generations, routing, refreshes, and lifecycle cancellation.
- [`src/wave3/domain.ts`](../src/wave3/domain.ts) — Homebridge-free normalized
  state, commands, results, and availability.
- [`src/wave3/codec.ts`](../src/wave3/codec.ts) — protobuf/JSON boundary and
  merge-safe display updates.
- [`src/wave3/controller.ts`](../src/wave3/controller.ts) — per-device state
  owner and command-confirmation engine.
- [`src/matterAccessory.ts`](../src/matterAccessory.ts) — endpoint construction,
  projection, write translation, UI-write coordination, and cache continuity.

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

The Matter adapter preserves staged off-state thermostat intent, carries
target/range with mode transitions, coalesces slider writes, suppresses
duplicates, preserves fractional Celsius, and distinguishes Sleep/Night from a
timer. These are the same semantic behaviors the blinded design requires.

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

### 2. Matter-specific intent planning lives partly in the adapter

**Blinded ideal:** the actor/application layer owns semantic intent planning,
including destination-mode profiles and write coalescing.

**Current:** the controller owns WAVE commands and confirmation, but
`Wave3MatterAccessory` owns Apple Home's staged-off mode/setpoint intent,
temperature/fan settling, and compilation of Matter writes into mode commands.

**Assessment:** partly justified. Apple Home write ordering, Matter transaction
guards, and setpoint deadband behavior are adapter concerns. WAVE's requirement
that a mode transition carry its destination target/range is domain policy,
however, and is now mixed into the Matter file. A small application-level
intent planner would make this policy reusable and easier to replay without a
Matter runtime while leaving UI-specific staging in the adapter.

### 3. Some inbound payloads are decoded twice

**Blinded ideal:** validate and decode once, then pass immutable normalized
events to the actor.

**Current:** the cloud session decodes display/quota messages to log them and
decide whether a refresh is superseded; it then forwards raw bytes, which the
controller decodes again for state reduction.

**Assessment:** the reason is understandable—refresh retry belongs to the
session, while authority belongs to the controller—but duplicate decode is not
an ideal long-term boundary. It couples transport lifecycle to WAVE display
semantics and makes the same bytes traverse the codec twice. Prefer a future
typed routed event containing the single validated decode plus generation and
route metadata, or move refresh-supersession decisions behind a controller
signal.

### 4. Authority freshness is category-level, not fully field-scoped

**Blinded ideal:** every field carries generation, source, receive ordinal,
monotonic observation time, and authority metadata.

**Current:** display merging is field-preserving and generation-aware, but the
controller uses a single control-state freshness timestamp once authority has
been established. A later recognized sensor delta can extend that overall live
window without repeating power and mode.

**Assessment:** the five-minute window is an evidence-based pragmatic policy
for a device that emits full state roughly every two minutes, and it prevents
visible two-minute stale flicker. It is nevertheless weaker than the blinded
model: a long stream of temperature-only deltas could conceal stale control
fields. This is a genuine follow-up. Track control-authority freshness
separately from sensor/runtime freshness, ideally using monotonic time.

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

### 7. Matter callback plumbing uses module-level registries

**Blinded ideal:** adapter-local intent ports with no shared mutable state.

**Current:** custom Matter behavior classes are instantiated by the running
Matter.js runtime, so module-level maps connect endpoint IDs to per-accessory
controls and mark expected internal attribute writes. Stop/release paths clear
both registries.

**Assessment:** justified by Homebridge/Matter.js construction and class
identity constraints, but the implementation mechanism should be encapsulated
as a small bridge/registry module. It is presentation plumbing, not device
authority, yet its current placement makes the already large Matter adapter
harder to review.

### 8. Diagnostics are safe strings rather than structured domain events

**Blinded ideal:** a typed semantic event sink plus counters.

**Current:** modules depend on a small logger interface and emit bounded,
redacted semantic strings. Sanitizers and tests prevent secrets, identifiers,
topics, and raw payloads from escaping.

**Assessment:** justified for the current plugin size and Homebridge's logging
surface. A logging framework is unnecessary. Typed internal diagnostic events
would become useful if counters, alternate sinks, or machine-readable support
bundles are added; redaction should then occur before rendering, not after.

### 9. Module boundaries exist, but several files are too large

**Blinded ideal:** separate modules for endpoint construction, projection,
intent planning, reducer, authority, command planning, confirmation, topics,
and individual codecs.

**Current:** the dependency direction is mostly correct, but
`matterAccessory.ts`, `session.ts`, `codec.ts`, and `controller.ts` each combine
several cohesive sub-responsibilities. Two type-only imports also point back
outward: the Matter adapter obtains its cached-context type from the platform,
and the controller obtains session lifecycle types from the cloud module.
These do not create harmful runtime cycles, but they make the architectural
contracts less clean than the blinded dependency rule.

**Assessment:** the small number of production files accelerated protocol and
hardware iteration while the correct policy was still moving daily. That was
a good pre-release trade-off. The policies now have enough hardware evidence
that mechanical decomposition would improve reviewability without changing
behavior. Move shared port/context types inward while splitting along
already-tested seams rather than introducing new frameworks or abstractions.

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

## Recommended follow-ups

The ordered implementation and verification sequence is tracked in the
[architecture hardening plan](architecture-refactor-plan.md).

### Before first release

1. **Separate control-authority freshness from sensor/runtime freshness.** A
   temperature-only stream must not keep power/mode authority alive forever.
2. **Decode inbound payloads once.** Route a typed normalized event or move
   refresh-supersession policy behind the per-device controller boundary.
3. **Decompose the Matter adapter without changing behavior.** Extract runtime
   behavior-class construction, endpoint/control registry, cluster projection,
   UI intent settling, and cache/reachability policy.
4. **Extract a WAVE semantic intent planner.** Keep Apple Home staging in the
   Matter adapter, but move destination profile compilation and no-op planning
   below it.
5. **Move cross-layer contracts inward.** Put the controller session port and
   cached Matter context beside the layer that owns the abstraction, removing
   the current type-only reverse dependencies.

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

The comparison does reveal four concrete cleanup opportunities: decode once,
separate control freshness from sensor freshness, move WAVE semantic planning
below the Matter-specific staging layer, and decompose the Matter adapter. The
other deviations are proportional simplifications or deliberate Homebridge UX
trade-offs and can be justified without special pleading.
