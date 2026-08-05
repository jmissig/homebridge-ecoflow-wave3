# Blinded greenfield architecture proposal

This proposal was produced by a fresh reviewer given only a sanitized product
brief and the protocol behavior recorded in this repository. The reviewer was
explicitly denied the source tree, existing implementation, prior architecture
decisions, author preferences, repository tools, and foreground conversation.
A context-isolation probe returned no foreground sentinel before the review.

The proposal is intentionally preserved separately from the later unblinded
[implementation comparison](architecture-comparison.md).

## Executive summary

Build the plugin as a narrow WAVE 3 integration with a pure protocol core, a
cloud/MQTT transport boundary, and one serialized device actor per configured
appliance. The device actor is the sole owner of live state and commands. It
reduces sparse, generation-tagged observations into an authoritative WAVE 3
state model and confirms writes through accumulated evidence rather than MQTT
delivery or sequence number alone.

The Homebridge boundary should expose native contemporary Matter endpoints and
clusters for a bridged room air conditioner. It reads only from a Matter-safe
projection of confirmed state and submits semantic intents to the device actor;
it must not decode protocol frames, hold speculative authoritative state, or
model the appliance through legacy HAP services.

Persist only recent confirmed presentation state, stable endpoint identity,
and non-secret metadata. Restored climate state may be displayed briefly after
restart, but remains read-only until current-connection authority is
established.

## Architectural principles

1. **Authoritative state is observed, never presumed.** Broker acceptance is
   not appliance acceptance, acknowledgements are transaction evidence rather
   than complete snapshots, and sparse packets refresh only fields they carry.
2. **One owner for mutable device state.** All observations, timeouts, Matter
   intents, reconnects, and command outcomes for one device pass through one
   serialized actor.
3. **Connection generation is part of evidence identity.** Prior-generation
   packets, replies, timers, and callbacks can never update or confirm the new
   generation.
4. **Operational state and saved mode profiles are distinct.** Remembered
   targets, airflow, and mode do not prove the appliance is powered on.
5. **Model semantic intent, not controller write order.** Compile Apple Home's
   split mode/setpoint/power writes into coherent WAVE-aware command bundles.
6. **All work is bounded and cancellation-aware.** Queues, retries, debounce
   windows, deadlines, payloads, and persisted history need explicit bounds.
7. **Remain WAVE 3-only.** Extract stable technical seams, not a speculative
   generic EcoFlow framework.
8. **Evolve from evidence.** Unknown fields remain unknown; new mappings need
   provenance, fixtures, and reducer tests.

## Components and dependency direction

```text
Homebridge 2.2.1 bootstrap
        |
        v
Matter adapter / endpoint projection
        |
        v
WAVE 3 application service
        |
        v
Per-device WAVE 3 actor
   |          |           |
   v          v           v
Domain     Command      Authority /
reducer    planner      freshness policy
   ^          |
   |          v
Normalized observations and command envelopes
   ^                          |
   |                          v
WAVE 3 protocol codecs    EcoFlow cloud port
                              ^
                              |
                  HTTPS auth + MQTT adapter

Persistence and diagnostic adapters implement inward-facing ports.
```

Dependencies point inward toward semantic policy:

- Infrastructure depends on protocol and application interfaces.
- The actor depends on pure domain types, clock/scheduler interfaces,
  transport ports, persistence ports, and diagnostic ports.
- The Matter adapter depends only on application state and intent interfaces.
- Codecs do not import Homebridge, persistence, logging, MQTT clients, or the
  actor.
- Domain code does not import Homebridge, MQTT, HTTP, protobuf libraries,
  filesystem APIs, or wall-clock globals.
- No layer reaches around the actor to mutate device state.

### Plugin bootstrap and configuration

- Validate account region, reviewed host, explicit device entries, names, and
  temperature-source selection before network activity.
- Reject duplicate device identifiers.
- Create one shared account cloud session and one actor per configured WAVE 3.
- Register stable Matter endpoints.
- Coordinate startup and shutdown under a root cancellation scope.
- Keep the schema WAVE 3-specific; do not add a generic product hierarchy.

### EcoFlow cloud session

- Own HTTPS authentication, MQTT certification, credential replacement,
  TLS-verified clean-session MQTT, subscriptions, and publications.
- Construct and parse only exact configured-device topics.
- Route immutable, generation-tagged inbound frames to the relevant actor.
- Emit connecting, connected, reconnecting, failed/offline, and stopped
  lifecycle events.
- Do not interpret climate state or decide whether a command succeeded.

### WAVE 3 protocol module

Pure responsibilities:

- topic construction and strict parsing;
- `latestQuotas` JSON request/reply codecs;
- display, runtime, command, set-reply, and get-reply protobuf codecs;
- wire-to-normalized observation mapping with explicit provenance;
- validation of sizes, bounds, enums, and envelope identity;
- classification into climate observation, runtime/device information,
  acknowledgement evidence, rejection/contradiction, or ignored foreign data.

Unknown sparse fields and binary get replies must not become generic activity
that refreshes climate authority.

### Per-device actor

The actor is the central correctness boundary. It owns:

- connection generation and current authority;
- operational state and per-mode profiles;
- runtime and firmware telemetry;
- pending coalesced intent and at most one published transaction;
- command evidence, freshness, and confirmation timers;
- restored presentation state and reachability;
- Matter projection revision.

Its FIFO mailbox accepts immutable events such as generation start/end,
normalized observation, Matter intent, coalescing deadline, confirmation
deadline, freshness deadline, and shutdown. With an injected clock and
scheduler, transitions should be deterministic.

### Domain reducer and authority policy

Use pure reducers with field-scoped evidence metadata. A delta containing
airflow updates airflow only; it does not refresh power, mode, target,
temperature, or global authority merely because the packet arrived.

### Command planner and confirmation engine

The planner converts semantic intent into a WAVE-aware command bundle. It:

- rejects writes before current-generation authority exists;
- uses the latest authoritative baseline;
- carries the destination target/range with mode transitions;
- coalesces rapid latest-value writes;
- suppresses no-ops and duplicates;
- serializes boundedly;
- records generation, transaction identity, wire sequence, baseline field
  revisions, intended field/value fingerprint, and required evidence.

The confirmation engine accumulates positive acknowledgement fragments and
later display evidence. Sequence equality alone never confirms a command.

### Persistence adapter

Persist only:

- schema version and stable endpoint/device mapping;
- a recent confirmed presentation snapshot and age metadata;
- confirmed firmware/device information;
- optionally bounded non-sensitive counters.

Do not persist credentials, tokens, MQTT credentials, topics, raw payloads, or
unconfirmed desired state. Writes should be atomic and debounced.

### Matter adapter

- Create a contemporary bridged Room Air Conditioner endpoint.
- Convert immutable actor projections into cluster attributes.
- Translate Matter writes into semantic intents.
- Report reachability and device information.
- Keep reads local and immediate; never perform network I/O during reads.
- Never decode protobuf or interpret acknowledgement fragments.

### Diagnostics

Use a structured redacting event sink receiving safe semantic events and
counters rather than arbitrary payload objects.

## Data flows

### Startup and reconnect

```text
Homebridge start
  -> validate configuration
  -> load stable identities and recent confirmed presentation
  -> register cached Matter presentation as unreachable/read-only
  -> authenticate and obtain temporary MQTT credentials
  -> connect, increment generation, subscribe
  -> tell each actor GenerationStarted(generation)
  -> request latestQuotas
  -> accept display/runtime uploads
  -> optionally issue one bounded experimental full-display request
  -> actor acquires current-generation power + active-mode authority
  -> publish reachable Matter projection and allow writes
```

```text
session failure
  -> cancel generation-bound work and mark devices unreachable
  -> retain only bounded read-only presentation cache
  -> reconnect with a new generation
  -> discard all prior-generation evidence
  -> reacquire authority before accepting writes
```

Never automatically retransmit an ambiguously published prior-generation
command.

### Inbound state

```text
MQTT frame
  -> attach route, generation, receive ordinal, monotonic receive time
  -> validate topic and envelope
  -> decode once into normalized observations/evidence
  -> enqueue actor event
  -> reject wrong generation
  -> reduce only explicitly present fields
  -> reconcile official-app changes as observed state
  -> evaluate pending command evidence
  -> derive reachability and Matter projection
  -> emit only changed projection revisions
  -> persist confirmed presentation on a bounded debounce
```

Runtime temperature and firmware packets update their own categories; they do
not refresh unrelated climate authority.

### Outbound command confirmation

```text
Matter writes
  -> semantic intents
  -> validate current-generation authority and legal constraints
  -> coalesce by semantic key
  -> compile one desired-state patch against the latest baseline
  -> include destination profile values on mode transition
  -> allocate transaction and publish QoS 1
  -> record broker acceptance only as published
  -> accumulate related positive acks and command-relevant display deltas
  -> correlate by generation + route + sequence where applicable
     + timing/order + field semantics + intended values
  -> complete only when required fields have qualifying evidence
  -> rejection/contradiction: fail and resynchronize
  -> deadline: mark unconfirmed, refresh state, never blindly retry
  -> re-plan the newest coalesced successor against observed state
```

Authoritative Matter state changes only from qualified device observations,
never from submitted intent.

## State and authority model

Keep operational state separate from saved profiles:

```ts
interface OperationalState {
  power: FieldState<boolean>;
  systemPausedOrSleeping: FieldState<boolean>;
  activeMode: FieldState<WaveMode>;
}

type ModeProfile = {
  target?: FieldState<Celsius>;
  lowerTarget?: FieldState<Celsius>;
  upperTarget?: FieldState<Celsius>;
  airflow?: FieldState<AirflowSetting>;
  submode?: FieldState<WaveSubmode>;
  targetHumidity?: FieldState<Percent>;
};
```

Each field should carry value, generation, source, receive ordinal, monotonic
observation time, and confirmation status. Wall time is suitable for display
and persistence, not ordering.

Authority rules:

- Scope authority by device, generation, field, source, and freshness.
- `latestQuotas` seeds only fields it contains under an explicit policy.
- Saved mode profiles never prove current power.
- Runtime packets do not refresh unrelated climate authority.
- Acknowledgements contribute transaction evidence but are not full state.
- Foreign app changes become state only through qualified observations.
- Full snapshots grant authority only to fields they actually contain.

Use named, tested durations for command confirmation, control-baseline age,
live climate age, restored presentation age, and runtime measurement age.
Explicit session/offline evidence overrides cached timestamps immediately.

After restart, restored state may provide continuity but remains marked
restored, unreachable, read-only, and ineligible as a command baseline until
replaced by current-generation observations.

## Concurrency and lifecycle

- Use one explicit FIFO actor/mailbox per device rather than incidental
  JavaScript callback ordering.
- Keep zero or one published transaction and only the latest safe successor
  intent.
- Coalesce slider values by semantic key and re-plan after each confirmed or
  failed transaction.
- A generation change aborts requests, confirmations, and correlation indexes.
- Default to cancelling queued writes on reconnect.
- On shutdown: stop writes, mark unreachable, cancel actor work and timers,
  flush bounded persistence, disconnect MQTT, dispose Matter listeners, and
  await all tasks under a hard deadline.

## Matter/Homebridge boundary

Use Homebridge 2.2.1 Matter APIs and official Matter device/cluster builders,
never legacy HAP services.

Expose one stable bridged Room Air Conditioner endpoint with standard
capabilities where the installed API supports them:

- power;
- thermostat/system mode;
- heating/cooling and automatic-range setpoints;
- fan control;
- relative humidity;
- ambient input-air temperature as the room-temperature measurement;
- bridged reachability and basic information/firmware.

Keep protocol support and controller visibility separate. Fan Only, Dry, and
Sleep/Night may exist in the domain even when Apple Home and Eve do not render
them. Do not invent vendor clusters or mislabel Sleep/Night as a timer.

Reads return the current immutable projection. Writes submit semantic intents
and map typed outcomes to Matter errors. Celsius remains canonical internally;
scaling occurs at the Matter boundary. Preserve fractional values accepted by
the appliance rather than inferring a whole-degree protocol limit from its
physical display.

## Security and diagnostics

- Allow reviewed regional origins by default and verify TLS fully.
- Bound redirects, requests, responses, payloads, retries, and error text.
- Keep temporary credentials in memory and clear references on replacement or
  shutdown.
- Never log or persist credentials, account identifiers, serials, topics, or
  raw payloads.
- Avoid generic serialization of errors or remote objects.
- Treat remote fields as untrusted.
- Keep dependencies small and protocol fixtures explicitly sanitized.

Useful safe events and counters include session transitions, authority
acquisition/loss, decode acceptance/ignore reasons, command lifecycle,
generation changes, reconnects, coalescing, rejection/unconfirmed counts, and
queue high-water marks. Test redaction across nested causes and dependency
errors.

## Testing strategy

- **Codec tests:** golden and malformed protobuf/JSON fixtures, topic parsing,
  unknown fields, bounds, and sanitized provenance.
- **Reducer/state-machine tests:** sparse deltas, remembered profiles while
  off, old generations, foreign app writes, runtime-vs-control freshness,
  restored read-only state, and explicit offline precedence.
- **Confirmation replays:** split/omitted acknowledgements, evidence spread
  across deltas, sequence collisions, contradictions, late packets, reconnect,
  rapid sliders, duplicates, and off-state staging.
- **Integration tests:** fake HTTP and MQTT, multiple devices on one account,
  clean-session reconnect, shutdown at every await point, persistence
  migration/failure, Homebridge loading, and Matter endpoint conformance.
- **Property/model tests:** old generations never change current authority,
  acknowledgements never invent unrelated state, at most one transaction is
  published per actor, revisions are monotonic, and diagnostics contain no
  secrets.
- **Hardware tier:** settle full-display effectiveness, `latestQuotas`
  authority, timing bounds, fractional setpoints, optional modes, and firmware.

## Suggested source layout

```text
src/
  plugin/          bootstrap, configuration, lifecycle
  matter/          endpoint, projection adapter, conversions, stable identity
  application/     service, device actor, events, ports
  domain/          state, profiles, reducers, authority, planner, confirmation
  protocol/        topics, JSON/protobuf codecs, generated code, validation
  infrastructure/
    cloud/         auth, certification, session, MQTT adapter
    persistence/   snapshot schema, store, migrations
    diagnostics/   events, redacting logger, counters
    time/          clock and scheduler

test/
  unit/            protocol, domain, Matter, security
  integration/     fake cloud/MQTT and Homebridge
  replay/          transcript-shaped scenarios
  fixtures/        sanitized protocol evidence
```

Generated protobuf types should not escape the handwritten protocol boundary.

## Anti-patterns to avoid

- Legacy HAP modeling.
- A platform god object.
- Treating deltas as full snapshots or refreshing all fields on any packet.
- Treating publish completion or sequence equality as success.
- Optimistic Matter state.
- Inferring power from remembered mode/profile or compressor state.
- Treating Sleep/Night as a timer or modes as additive booleans.
- Sending a mode without its destination target/range.
- Automatically replaying uncertain writes after reconnect.
- Letting prior-generation callbacks survive.
- Unbounded queues, promises, retries, payloads, or diagnostics.
- One network command per slider event.
- Wall-clock packet ordering.
- Raw dependency/object logging.
- Persisting credentials or unconfirmed intent.
- Generic EcoFlow abstractions before a second product exists.
- Custom/vendor Matter behavior solely to compensate for controller UI.
- Silent temperature-source substitution.
- Treating the experimental full-display request as authority.

## Open questions

- Which exact Homebridge 2.2.1 Matter builders support the optional modes,
  presets, and omitted current temperature?
- Which `latestQuotas` fields qualify as control authority?
- Can system pause and Sleep/Night coexist, and how are they distinguished?
- Does the one-shot full-display request reliably provoke useful state?
- Which acknowledgements mean accepted, applied, or rejected?
- What are safe confirmation, freshness, cache, and coalescing durations?
- Which envelope identifiers supplement sequence correlation across clients?
- What are the exact constraints for every mode and firmware revision?
- How does firmware canonicalize fractional Celsius values?
- What Matter errors best represent unreachable and unconfirmed writes?
- Does Homebridge provide a secure credential store beyond configuration?
- Is one certified account session always valid for multiple devices?
- Should hidden Fan Only, Dry, and Sleep/Night mappings remain latent until
  controller interoperability improves?

## What the reviewer was blinded to

- the existing implementation;
- prior architecture decisions;
- author preferences.

The proposal is a greenfield design, not a review of existing code.
