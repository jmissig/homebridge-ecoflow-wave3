# Household WAVE 3 packet evidence — 2026-08-01

This is a redacted ledger of representative packets observed during the first
household hardware-validation session. It records what the plugin actually saw
on MQTT; it is not an official EcoFlow protocol specification.

## Redaction boundary

The source logs were shared by Julian from an isolated Homebridge child bridge.
This ledger intentionally omits:

- EcoFlow account and user IDs
- device serial numbers
- MQTT client IDs, usernames, passwords, and tokens
- full MQTT topics where they contain an account or device identifier
- raw packet bytes
- generated quota request IDs

Device sequence numbers, packet lengths, protobuf field numbers, and decoded
climate values are retained because they are protocol evidence rather than
stable account identifiers.

## Source log sets

- Initial connection and partial display packets.[^src-initial]
- Official-app fan and temperature changes.[^src-app-controls]
- HomeKit target, power, and fan validation.[^src-homekit-controls]
- Startup dominated by partial humidity packets.[^src-partial-startup]
- Extended app-coexistence traffic, full display state, runtime telemetry, and
  non-JSON get replies.[^src-app-coexistence]

[^src-initial]: [Household Homebridge diagnostic paste · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533270401684082809)
[^src-app-controls]: [Household Homebridge diagnostic paste and narrated app actions · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533272688766877849)
[^src-homekit-controls]: [Household Homebridge diagnostic paste and physical observation · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533275994385813545)
[^src-partial-startup]: [Household Homebridge startup diagnostic paste · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533281252147466311)
[^src-app-coexistence]: [Household Homebridge app-coexistence diagnostic paste · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533281795536195604)

## Transport and routing

**Observed**

- Private-cloud authentication and MQTT certification succeeded against the
  Americas service. The broker connection used TLS on port `8883`.
- The plugin subscribed to five topics for the configured device before
  publishing its initial `latestQuotas` request.
- The broker acknowledged the subscription and publication operations.
- The broker echoed property-get and property-set publications on the
  corresponding subscribed topics.
- The WAVE 3 published state on the redacted
  `/app/device/property/<device>` topic while the official EcoFlow app remained
  connected.
- Official-app requests and replies were visible on the same account/device
  topic family. This confirms that app/plugin coexistence exposes traffic from
  both clients to the plugin's subscriptions.

## Display property packets — `cmd_func=254`, `cmd_id=21`

### Incremental sensor packets

**Observed**

- A `53`-byte envelope with an `18`-byte display payload at sequence `8830`
  decoded ambient temperature `19.09 °C` plus two then-unknown fields.
- A later `47`-byte envelope with a `12`-byte display payload at sequence
  `8858` contained no recognized first-slice climate field.
- Repeated `42`-byte envelopes with `6`-byte display payloads carried only
  ambient humidity. Observed values included `73.20%`, `74.25%`, `72.06%`,
  `71.06%`, and `72.14%`.
- During one restart, humidity-only packets arrived from one second after MQTT
  readiness until the authoritative full display packet arrived roughly
  `97` seconds after child-bridge startup.
- After authoritative state had arrived, further humidity-only packets
  correctly acted as incremental updates without removing the accumulated
  temperature, power, mode, target, or airflow state.

**Implementation consequence**

- A partial display packet proves that the device is publishing, but cannot by
  itself identify the active control state for a new MQTT generation.
- Sensor-only and saved-mode-parameter packets must not supersede a pending
  full-state refresh. A nonzero `wave_operating_mode` alone is also
  insufficient because full packets proved that saved mode `1` can coexist
  with `dev_sleep_state=1`/off. Initial control state requires both fields;
  explicit operating mode `0` remains intrinsically off.

### Full and mode-parameter display packets

**Observed**

- Representative full envelopes were `327` or `328` bytes with a `289`-byte
  display payload.
- Full packets supplied:
  - `dev_sleep_state`
  - ambient temperature and humidity
  - `wave_operating_mode`
  - saved parameters for modes `1` through `5`
- Representative full state while cooling included:
  - operating mode `1` (cool)
  - ambient temperature `19.23–23.90 °C`
  - ambient humidity `58.53–73.48%`
  - airflow `20%`
  - target `20.8–21.0 °C`
- One full packet reported `dev_sleep_state=1` with saved operating mode `1`;
  normalization treated the appliance as powered off while retaining the
  saved cool-mode target and airflow settings.
- Representative saved mode parameters were:
  - mode `1` / cool: airflow `20`, `40`, or `100`; target `20.8`, `21.0`, or
    `21.8 °C`; observed submodes included `1` and `4`
  - mode `2` / heat: airflow `40`; target `26 °C`; observed submode `1`
  - mode `3` / fan: airflow `40`
  - mode `4` / dry: airflow `100`; unknown mode-item field `4` decoded as
    fixed32 float `50`
  - mode `5` / automatic: airflow `40`; target `28 °C`; lower threshold
    `26 °C`; upper threshold `30 °C`
- Mode-parameter-only envelopes were commonly `94`, `100`, `101`, or `107`
  bytes. They updated saved mode parameters but did not necessarily repeat the
  active operating mode.

### Unknown display fields

**Observed**

- Payload fields `53` and `777` appeared as fixed32 values carrying identical
  floats in the same or adjacent updates. Observed values ranged from `0` and
  about `1.80` through more than `340` while the unit ramped.
- Mode-item field `4` repeatedly decoded as fixed32 float `50` in dry-mode
  saved parameters.
- A full display packet contained many additional fields outside the first
  climate slice, including payload field numbers `5`, `17`, `18`, `53`, `61`,
  `96`, `126`, `133`, `134`, `135`, `158`, `195`, `242`, `248`, `254`, and
  `255`.

**Inference**

- Fields `53` and `777` track power telemetry. Their synchronized values and
  ramp behavior agree with the pinned upstream power-field definitions.
- Mode-item field `4` is the dry-mode humidity target. This agrees with the
  pinned upstream schema and the stable value `50`.
- These fields are useful diagnostics but are not required for the first
  HomeKit climate surface.

## Runtime packets — `cmd_func=254`, `cmd_id=22`

**Observed**

- A representative runtime envelope was `265` bytes with a `226`-byte
  payload.
- It decoded:
  - indoor return air: `24.14 °C`
  - outdoor ambient: `24.28 °C`
  - condenser: `24.23 °C`
  - evaporator: `23.29 °C`
  - compressor discharge: `35.24 °C`
- Earlier runtime state while actively cooling included indoor return air
  `13.59 °C`, outdoor ambient `25.24 °C`, condenser `32.57 °C`, evaporator
  `13.91 °C`, and compressor discharge `43.28 °C`.
- Runtime packets also contained many fields outside the first climate slice.

## Configuration acknowledgements — `cmd_func=254`, `cmd_id=18`

**Observed**

- Official-app airflow changes returned positive acknowledgements with action
  ID `155` and values `40`, `100`, and `20`. Later display packets reported
  the same active cool-mode airflow values.
- Official-app target changes returned positive acknowledgement action ID
  `156`; one captured value was `20.8 °C`. Display packets reflected `20.8 °C`
  and `21.8 °C` for app-visible `21 °C` and `22 °C` settings respectively.
- HomeKit-originated target writes received positive action-ID `156`
  acknowledgements and later matching display state.
- HomeKit-originated power-on traffic received a positive action-ID `4`
  acknowledgement with `mainPower=true`.
- Other official-app traffic produced action IDs `6`, `7`, `135`, `136`, and
  `172`. Several positive replies shared the same envelope sequence while
  acknowledging different action IDs/fields. Their exact semantics are not
  established, but the traffic proves that one logical compound operation can
  yield acknowledgement fragments rather than one all-fields reply.
- A `set_reply` with `cmd_id=20` was observed during official-app activity. It
  is not the `cmd_id=18` configuration acknowledgement implemented by the
  plugin and was safely ignored.

## HomeKit command behavior

**Observed**

- Target-temperature writes from Home changed the physical device and were
  reflected in the EcoFlow app.
- Power off/on writes from Home worked end to end.
- Rapid Home fan-slider interaction produced acknowledged airflow commands
  `80`, `100`, and a redundant `100` within roughly two seconds. Each command
  triggered an explicit quota refresh.
- During the burst, synchronized power telemetry fell to about `1.8 W` and
  then ramped upward. Julian physically observed the unit stop or restart and
  suspected one or more hardware/firmware crashes.

**Inference and resulting safety policy**

- The power trace is consistent with a control-cycle restart but does not
  alone prove a firmware crash.
- Fan and temperature sliders therefore use a settling window, latest-value
  coalescing, serialization, and confirmed-duplicate suppression.

## Official-app get traffic and quota JSON

**Observed**

- With the official app open, repeated property-get publications of about
  `49` bytes were followed by property-get replies of about `705–706` bytes.
- These replies had no parseable `latestQuotas` string request ID and were not
  valid UTF-8 JSON.
- They appeared only as unrelated account/device traffic; no plugin refresh
  was pending when many of them arrived.

**Inference and implementation consequence**

- The `705–706` byte replies are binary traffic belonging to another EcoFlow
  request/client, most plausibly the official app.
- Unmatched get replies must be dropped before quota decoding. Diagnostics may
  classify them only as JSON-object-shaped or non-JSON; strict UTF-8 and quota
  JSON decoding is reserved for replies whose request ID matches the plugin's
  pending refresh.

## Concurrent-client resilience

**Implementation policy derived from the observed coexistence traffic**

- Subscribe only to `property`, `set_reply`, and `get_reply`. The plugin still
  publishes to `set` and `get`, but no longer receives either client's echoed
  outbound requests.
- Match quota replies to the plugin's current request ID and MQTT generation;
  drop all other replies before quota decoding.
- Require both sleep state and nonzero active-mode evidence before partial
  property traffic can establish a new MQTT generation or supersede its
  initial refresh; explicit mode `0` is sufficient to establish off.
- Randomize the first command sequence in the evidenced `10–999` range after
  each plugin restart, then advance sequentially.
- Ignore a same-sequence acknowledgement when its echoed fields conflict with
  or are unrelated to the plugin's pending command. Accumulate positive
  matching fragments for composite commands, then require a later matching
  display update before confirming success.
- Serialize HomeKit writes and coalesce slider traffic. A genuine official-app
  change may still race a HomeKit change; the device remains last-writer-wins,
  and the plugin reports only subsequently observed state.

## Temperature-source decision

- Display field `494` appeared at `20.13`, `19.12`, `17.69`, and `16.60 °C`
  while cooling ramped. The pinned upstream schema identifies field 494 as
  `temp_indoor_supply_air`; the plugin now provisionally labels it outlet /
  supply-air temperature.
- Per-device HomeKit configuration offers `ambient`, `outlet`, and `none`.
  Ambient alone adds the ambient-humidity companion. `none` removes the
  normally required `HeaterCooler.CurrentTemperature` characteristic and is
  explicitly experimental until tested in Apple Home.

[Decision: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533304877189431447)

## Evidence still missing

- Exact semantics of acknowledgement action IDs beyond the mapped climate
  writes
- Exact meaning of `cmd_id=20`
- Long-session command reliability and safe recovery
- Firmware-version field and command path
- Apple Home behavior for the experimental no-temperature HeaterCooler shape
- Whether account device discovery can be implemented through a stable private
  endpoint
