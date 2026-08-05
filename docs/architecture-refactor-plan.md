# Architecture hardening implementation record

This record turns the five pre-release follow-ups from the
[blinded architecture comparison](architecture-comparison.md) into bounded,
reviewable changes. It is a refactor, not a redesign: the
shared cloud session, per-device controller, confirmed-state model, Matter-only
product surface, Homebridge cache, and WAVE 3-only scope remain unchanged.

The five changes were implemented sequentially in one working tranche with one
consolidated review and verification sweep at the end. Git history provides the
recovery boundary; the implementation does not require artificial pause or
rollback checkpoints between mechanical extractions.

The work was requested after reviewing the current implementation against the
blinded proposal. told: Julian · 2026-08-02

## Objectives

1. Separate control-authority freshness from sensor and runtime freshness.
2. Decode each inbound EcoFlow payload exactly once.
3. Decompose the Matter adapter along its already-tested responsibilities.
4. Move WAVE-specific semantic intent planning below Apple Home/Matter staging.
5. Move shared contracts inward so lower layers do not import types from their
   infrastructure or composition consumers.

## Non-goals

- No actor-framework rewrite.
- No generic EcoFlow SDK or multi-product abstraction.
- No second persistence store or migration away from Homebridge context.
- No change to accessory UUIDs, endpoint shape, configuration schema, or cache
  schema unless a test proves one is necessary.
- No optimistic state, automatic command replay, or weaker confirmation.
- No new Matter controls or protocol mappings.
- No change to the documented cached-presentation grace period.

## Implementation order

Implement five ordered changes, keeping focused tests green as ownership moves.
Run the complete suite, package inspection, diff review, and security review
once after the integrated result is assembled.

```text
1. Inward contracts
        |
        +--> 2. WAVE intent planner --> 5. Matter decomposition
        |
        +--> 3. Decode-once events --> 4. Field-scoped freshness
```

The ordering minimizes churn:

- inward contracts establish the final dependency direction first;
- extracting WAVE planning removes domain policy from the Matter file before
  that file is split;
- decode-once events give freshness logic explicit normalized field evidence;
- Matter decomposition happens after the two responsibilities being moved out
  of it have stable homes.

## Phase 1 — Move cross-layer contracts inward

### Goal

Remove the two reverse type dependencies without changing runtime behavior:

- `wave3/controller.ts` must not obtain its session port and lifecycle types
  from `ecoflow/session.ts`;
- the Matter adapter must not obtain its cached-context type from
  `platform.ts`.

### Work

- Add a WAVE-facing session-port module owned by the controller/application
  side. It should define only what a controller consumes: lifecycle state,
  inbound-event subscription, error/state subscriptions, command publication,
  and explicit state refresh.
- Let `EcoFlowCloudSession` implement that port structurally. Keep HTTPS,
  MQTT, retry, and credential types inside `src/ecoflow/`.
- Move `Wave3MatterAccessoryContext` beside the Matter cache/context policy.
  Both the platform composition root and Matter adapter import it from there.
- Move the small logger contract to a neutral inward module only if doing so
  removes another reverse dependency; do not introduce a logging framework.
- Preserve existing public exports temporarily when that keeps tests and
  downstream imports mechanical.

### Acceptance

- No import from `src/wave3/` to `src/ecoflow/session.ts`.
- No import from Matter code to `src/platform.ts`.
- No emitted JavaScript or behavioral difference beyond module paths.
- Platform lifecycle, controller, Matter, and cache-restoration tests pass.

## Phase 2 — Extract the WAVE semantic intent planner

### Goal

Keep Apple Home write staging in the Matter layer while moving WAVE profile
semantics into a pure, Homebridge-free planner.

### Boundary

The Matter adapter continues to own:

- Matter attribute and transaction handling;
- off-state UI staging;
- slider/setpoint settling and debounce timing;
- conversion between Matter centidegrees/enums and domain values;
- application of confirmed projections back to Matter.

The WAVE planner owns:

- compiling an active setpoint/range intent against the latest confirmed WAVE
  state;
- normalizing the WAVE-specific Auto range while preserving fractional values;
- preserving separate Cool, Heat, Auto, Fan, Dry, and submode profiles;
- suppressing semantic no-ops;
- rejecting an intent when its required confirmed baseline is absent.

Command serialization, publication, and evidence-based confirmation remain in
`Wave3Controller`.

### Work

- Introduce pure semantic-intent and planning-result types in `src/wave3/`.
- Keep WAVE active-target/range planning independent of Matter while the
  Matter boundary owns revisioned controller-write ordering.
- Have the Matter write coordinator produce revisioned semantic intents,
  confirm power and mode separately, and invoke the target/range planner with
  a fresh immutable controller snapshot.
- Keep protocol encoding unaware of Matter and keep the planner unaware of
  Homebridge/Matter.js classes.
- Document the distinction between controller write-order staging and WAVE
  destination-profile policy in code comments.

### Acceptance

- Matter integration tests replay:
  - Off -> Cool with the staged Cool target;
  - Off -> Heat without leaving the WAVE at its remembered 26 °C target;
  - Cool <-> Heat with distinct saved targets and confirmed intermediate mode;
  - supersession by a newer mode/target intent;
  - immediate power-off cancellation of queued target/fan work;
- Pure planner tests cover:
  - Auto lower/upper ranges;
  - no-op and missing-baseline cases;
  - fractional Celsius preservation.
- Existing Matter runtime tests produce the same outbound `Wave3Command`
  sequences as before extraction.
- The planner imports no Homebridge, Matter, MQTT, protobuf, or persistence
  module.

## Phase 3 — Decode inbound payloads once

### Goal

Make the cloud-session route the sole raw-payload decoding boundary and pass a
validated, immutable WAVE event to the controller.

### Event contract

Define a discriminated inbound event carrying:

- configured device route;
- connection generation;
- inbound kind/source;
- the already-decoded display update, runtime update, acknowledgement, quota
  result, malformed/unsupported classification, or intentionally ignored
  result;
- bounded diagnostic metadata that contains no raw payload or identifier.

Raw payload bytes must not cross into `Wave3Controller`.

### Work

- Add a pure protocol-router function that converts a routed MQTT message into
  one normalized inbound event.
- Decode immediately after strict topic/device routing in
  `EcoFlowCloudSession`.
- Reuse that same decoded result for bounded logging and startup-refresh
  supersession/retry decisions.
- Emit the normalized event through the Phase 1 controller session port.
- Change `Wave3Controller` to reduce the event directly; remove its codec
  imports and decode branches.
- Keep malformed, foreign, unknown, and binary get-reply traffic explicitly
  classified rather than turning it into authority or freshness.
- Do not move command encoding: controller -> codec -> session remains the
  outbound boundary.

### Acceptance

- `Wave3Controller` imports no decode function and accepts no raw inbound
  payload.
- Router tests cover property, runtime, acknowledgement, quota reply,
  malformed, unknown, and foreign traffic.
- Session tests prove refresh retry/supersession still uses the same decoded
  evidence and generation.
- Controller replay tests consume typed events and preserve all current
  acknowledgement/display confirmation outcomes.
- Diagnostics remain redacted and do not serialize raw decoder objects.

## Phase 4 — Make operational freshness category-scoped

### Goal

Prevent sensor or runtime traffic from keeping stale power/mode authority
alive while retaining the evidence-based five-minute tolerance for the WAVE's
roughly two-minute full-state cadence.

This is the only planned phase that intentionally changes runtime policy.

### Model

- Distinguish:
  - operational authority: power/system-pause and active operating mode;
  - saved profile authority: target/range, airflow, submode, and humidity per
    WAVE mode;
  - presentation sensors: ambient input-air temperature and humidity, with
    outlet temperature retained only as decoded telemetry;
  - runtime/device information: internal temperatures and firmware.
- Only an update carrying operational control evidence renews the existing
  five-minute authority deadline. Sensor, saved-profile-only, and runtime
  observations update presentation but never renew that deadline.
- Reachability/writability require fresh current-generation operational
  authority. Saved-profile values remain merge-preserved within that generation
  and are validated by the existing command planner and confirmation engine.
- Acknowledgements remain transaction evidence and must not masquerade as
  general device-state freshness.
- Explicit cloud/session failure still makes the device unavailable
  immediately.
- Preserve a wall-clock confirmation time for cache age while using an
  injected monotonic deadline clock for live freshness where practical.

### Work

- Narrow the controller's `updatedAt` meaning to operational-control authority
  rather than “any recognized display evidence.”
- Use the decoded update's explicit normalized fields to decide whether the
  operational deadline renews.
- Keep sensor/profile/runtime merging independent from command eligibility.
- Keep the existing five-minute operational limit initially; change only what
  can renew it.
- Preserve Homebridge's 15-minute cached-presentation grace as an independent
  UI policy.

### Acceptance

Use an injected deterministic clock to prove:

- a full control snapshot remains online through 299,999 ms and becomes stale
  at 300,000 ms;
- repeated ambient/outlet/humidity/runtime packets do not postpone that
  transition;
- a valid current-generation power/mode update renews operational authority;
- a profile-only update merges its values but does not renew operational
  authority;
- a reconnect invalidates all prior-generation field authority;
- an explicit offline/failure event overrides every timestamp immediately;
- cached presentation remains visible according to its existing independent
  policy but cannot authorize writes;
- command confirmation still accumulates pre-command state, acknowledgements,
  and post-command deltas without being conflated with general freshness.

### Hardware follow-up

After deployment, observe at least two normal full-upload intervals plus one
Home/app control round trip. Confirm there is no two-minute No Response flicker
and that sensor-only traffic cannot hide a missing full control upload.

## Phase 5 — Decompose the Matter adapter

### Goal

Split `matterAccessory.ts` along existing responsibilities after WAVE planning
has moved out, without changing endpoint shape or behavior.

### Proposed seams

- **Device type/behavior construction:** runtime Homebridge/Matter.js behavior
  classes and feature composition.
- **Control registry:** the module-level bridge between Matter.js-instantiated
  behavior classes and per-accessory controls, including cleanup invariants.
- **Projection:** pure conversion from confirmed controller snapshots to
  Matter attribute patches.
- **Write coordinator:** Apple Home transaction guards, desired-value tracking,
  staging, settling, and planner invocation.
- **Cache/reachability policy:** context schema, recent-cache rules, and
  presentation grace.
- **Accessory binding:** the small orchestrator that wires these pieces to one
  endpoint and owns shutdown.

The exact filenames may follow repository conventions; the ownership seams are
the contract.

### Work

- Extract one seam at a time, keeping a compatibility barrel at
  `matterAccessory.ts` until platform imports and tests have moved cleanly.
- Encapsulate the module-level maps and enforce duplicate registration,
  expected-write consumption, and release cleanup inside the registry module.
- Keep behavior classes sourced from the running Homebridge process to avoid a
  second incompatible Matter.js class identity.
- Move snapshot-to-attribute calculations into pure projection helpers and
  retain installed-runtime probes for actual endpoint mutations.
- Move timer ownership and cancellation with the write coordinator; stopping
  a binding must drain or cancel all pending work.
- Split tests by responsibility only after each extraction is green; do not
  rewrite tests wholesale.

### Acceptance

- Accessory UUIDs, endpoint composition, feature flags, cluster attributes,
  cache schema, and Homebridge registration calls are unchanged.
- The ambient-temperature and humidity endpoint-shape tests pass.
- Apple Home delayed-write, setpoint crossing, fan coalescing, duplicate
  suppression, cache recovery, firmware, and shutdown tests pass unchanged.
- Installed-runtime Matter probes still use the running Homebridge/Matter.js
  types and clean up their sockets/tasks.
- The registry has focused tests proving registration and stop/release leave no
  cross-accessory state behind.
- The final accessory-binding module reads as composition rather than policy.

## Consolidated verification gates

After the integrated change, run:

```bash
npm run verify
npm pack --dry-run
```

Also require:

- `git diff --check`;
- no changed configuration or accessory-cache schema without an explicit
  migration decision;
- no newly logged account, serial, topic, credential, or raw-payload data;
- no reduction in generation, shutdown, reconnect, or command-confirmation
  coverage;
- focused installed-runtime Matter probes whenever Matter modules change.

## Final acceptance

The architecture-hardening tranche is complete when:

- the five dependency/ownership goals above are visible in imports and tests;
- all automated verification and package inspection pass;
- a restarted child bridge reacquires authoritative state normally;
- Home Off -> Cool/22 °C, fan adjustment, official-app inspection/change, and
  Home Off all confirm without false failures;
- five-minute operational-category freshness behaves as designed during an unattended
  observation window;
- the protocol, architecture comparison, troubleshooting, and TODO documents
  describe the final boundaries accurately.

## Final review

Review the integrated dependency direction, ownership seams, behavior-preserving
tests, packaged artifact, diagnostics redaction, and hardware follow-up as one
coherent result. Correct any issue at its owning seam rather than compensating
in a later layer.
