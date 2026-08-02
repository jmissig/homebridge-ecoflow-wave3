# WAVE 3 protocol dossier

This document records the evidence boundary for the first
`homebridge-ecoflow-wave3` implementation. It is not an official EcoFlow
protocol specification.

## Pinned upstream

The first port is based on:

- Repository: [`tolwi/hassio-ecoflow-cloud`](https://github.com/tolwi/hassio-ecoflow-cloud)
- Commit: [`95dc51eb12562c49be9067052814d5960cc0829f`](https://github.com/tolwi/hassio-ecoflow-cloud/commit/95dc51eb12562c49be9067052814d5960cc0829f)
- Retrieved: 2026-07-28
- Upstream license: Apache License 2.0

Files used as evidence:

| Upstream file | Purpose | SHA-256 |
| --- | --- | --- |
| `custom_components/ecoflow_cloud/devices/internal/wave3.py` | WAVE 3 envelope decoding, state mapping, climate commands | `fce574aeade175e853382d5d881ef735d00aece00a1f78b1bf4f6f6f449b3183` |
| `custom_components/ecoflow_cloud/devices/internal/proto/wave3.proto` | Message and field-number schema | `75c47794f1470d2b5887af7440ee0a193c3a20662c44b76cfd3051b7956d7cae` |
| `custom_components/ecoflow_cloud/api/private_api.py` | Private login, MQTT certification, client ID, app topics | `8d9aee9176f7b46f3c0090e863b2265dd5bf7ae63437c80b0eccc7faac8a5467` |
| `custom_components/ecoflow_cloud/api/ecoflow_mqtt.py` | MQTT TLS, keepalive, QoS, subscription lifecycle | `3afa6ddbedb5163b0959f9af40425c6ab97b73943b288abce3d743ea820995a4` |
| `custom_components/ecoflow_cloud/api/message.py` | Private JSON command envelope and request ID | `907bbf2249c73a92c6dd82705d50bb9a3efdf6b3688d7fa09d8658b87be13fd7` |
| `custom_components/ecoflow_cloud/devices/__init__.py` | Topic routing and `latestQuotas` refresh | `57284591d01b545dc99013264893719b78afc8581eb62813cdae05bec67dcb27` |

The initial WAVE 3 contribution and discussion are preserved in
[upstream PR #762](https://github.com/tolwi/hassio-ecoflow-cloud/pull/762).

## Confidence labels

- **Upstream** — directly present in the pinned upstream code or schema.
- **Inference** — our interpretation or proposed behavior based on upstream
  evidence; not yet confirmed by hardware.
- **Hardware** — reserved for behavior observed against the household WAVE 3.

Hardware confidence is recorded only for the bounded observations below; it
does not yet establish supported Matter controls.

The detailed redacted packet ledger from the first household validation lives
in [Household WAVE 3 packet evidence — 2026-08-01](hardware-packet-evidence-2026-08-01.md).

## Private authentication

**Upstream**

1. `POST https://{apiHost}/auth/login`
2. JSON body:
   - `email`: EcoFlow account email
   - `password`: UTF-8 password encoded as Base64
   - `scene`: `IOT_APP`
   - `userType`: `ECOFLOW`
3. Headers include `lang: en_US` and `content-type: application/json`.
4. The response supplies `data.token` and `data.user.userId`.
5. `GET https://{apiHost}/iot-auth/app/certification` uses
   `Authorization: Bearer {token}`. The pinned client passes `{"userId": ...}`
   through aiohttp's `data=` mapping, producing URL-encoded body bytes, while
   retaining its explicit `content-type: application/json` header.
6. The certification response supplies:
   - `data.url`
   - `data.port`
   - `data.certificateAccount`
   - `data.certificatePassword`
7. The observed client ID is
   `ANDROID_{random uppercase hex}_{userId}`.

**Inference**

- The plugin should initially allow only reviewed EcoFlow API hosts:
  `api.ecoflow.com`, `api-a.ecoflow.com`, and `api-e.ecoflow.com`.
- An arbitrary host override would send account credentials elsewhere and
  therefore must not be part of the normal configuration surface.
- Login and certification response bodies are sensitive even when an HTTP
  request fails and must never be logged verbatim.

## Device selection

**Upstream**

- The private API client's `fetch_all_available_devices()` returns an empty
  list.
- Home Assistant's private/manual flow asks the operator for device type,
  display name, and serial number.
- The device registry maps `WAVE_3` to the WAVE 3 implementation.

**Inference**

- The first Homebridge slice must require an explicit WAVE 3 serial number.
- Because this repository supports only WAVE 3, it must not offer a generic
  device-type selector or attempt public-API discovery for other EcoFlow
  products.
- Account discovery should be added only if a later, pinned private endpoint
  provides reliable WAVE 3 identity evidence.

## MQTT session

**Upstream**

- Broker URL, port, username, and password come from app certification.
- TLS certificate verification is required; insecure TLS is disabled.
- The client uses a clean session and a 15-second keepalive.
- Subscriptions and publications use QoS 1.
- The client subscribes after every successful connection.
- `EcoflowDeviceInfo.topics()` supplies all non-null device topics to the
  subscription list, including the `set` and `get` publication topics as well
  as `property`, `set_reply`, and `get_reply`.

For a configured serial number `{sn}` and authenticated `{userId}`:

| Purpose | Topic |
| --- | --- |
| Device property stream | `/app/device/property/{sn}` |
| Property set | `/app/{userId}/{sn}/thing/property/set` |
| Property set reply | `/app/{userId}/{sn}/thing/property/set_reply` |
| Property get | `/app/{userId}/{sn}/thing/property/get` |
| Property get reply | `/app/{userId}/{sn}/thing/property/get_reply` |

The initial refresh is JSON published to the property-get topic:

```json
{
  "from": "HomeAssistant",
  "id": "<per-request numeric string>",
  "version": "1.1",
  "moduleType": 0,
  "operateType": "latestQuotas",
  "params": {}
}
```

A matching get reply contains `data.online` and `data.quotaMap`.

**Inference**

- The Homebridge transport should subscribe before publishing the initial
  refresh.
- Household hardware confirmed that the `set` and `get` subscriptions only
  expose echoed plugin/app publications. The plugin therefore subscribes only
  to the three inbound topics: `property`, `set_reply`, and `get_reply`.
- Every reconnect should re-subscribe exactly once and publish an immediate
  refresh. If EcoFlow supplies only supplemental telemetry or drops that
  request, repeat `latestQuotas` after 5, 10, and 20 seconds, then every 30
  seconds until authoritative active-mode state or an explicit offline reply
  arrives. Reconnect, shutdown, and authoritative state cancel the retry loop.
- At child-bridge startup, a device with no cached authoritative state or a
  `lastConfirmedAt` older than the same 15-minute Matter cache window also gets
  exactly one WAVE-specific configuration-write trigger:
  `active_display_property_full_upload = true` (action `71`). A recent cache
  suppresses this trigger. The request does not modify periodic upload
  intervals and is not part of the `latestQuotas` retry loop.
  [Decision: Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533518835838222407)
- Action `71` is defined by the
  [pinned upstream WAVE 3 schema](https://github.com/tolwi/hassio-ecoflow-cloud/blob/95dc51eb12562c49be9067052814d5960cc0829f/custom_components/ecoflow_cloud/devices/internal/proto/wave3.proto#L288-L293).
  Its ability to provoke the expected immediate full `cmd_id = 21` property
  upload remains an implementation inference until the household device
  confirms it.
- MQTT setup completing means only that the cloud transport is ready. The
  controller remains stale and rejects writes until current-generation WAVE 3
  climate evidence arrives. A valid `latestQuotas` get reply supplies that
  evidence; `data.online == 0` makes the device unavailable, and malformed
  replies do not revive cached pre-reconnect state.
- Each refresh keeps its generated request ID until one matching get reply is
  consumed. A newer refresh, reconnect, or intervening validated display update
  with authoritative active-mode state and a newer device sequence supersedes
  the pending reply so delayed quota snapshots cannot regress the current
  connection generation. Runtime, sensor-only, saved-mode-parameter-only,
  malformed, unsupported-only, duplicate, and out-of-order property packets do
  not consume the pending refresh.
- Inbound packets are ignored while MQTT is disconnected. Each clean-session
  connection is assigned a generation, and the controller discards its prior
  generation accumulator before accepting new device evidence.
- MQTT.js automatic resubscription is disabled because the session owns that
  ordering. If a reconnect subscription or refresh fails, the session closes
  the connection and requires replacement instead of leaving a partially
  initialized live connection.
- MQTT.js dependency logging is forced to a no-op because its debug packets can
  contain credentials, full serials, topics, and payload bytes.
- Packet routing, bounded decode summaries, controller snapshots, refresh IDs,
  and command-settling traces use Homebridge's standard debug logger and are
  hidden during normal operation. Authentication milestones, connection
  warnings, and errors remain visible without debug mode.
- Topic strings, client IDs, usernames, and full serial numbers are sensitive
  diagnostics and must be redacted.

## Binary envelope

**Upstream**

- Outer message: `Wave3SetMessage`
- Header: `Wave3SetHeader`
- Payload bytes: `header.pdata`
- WAVE function ID: `header.cmd_func == 254`
- Display/full or incremental property upload:
  `header.cmd_id == 1 || header.cmd_id == 21`
- Runtime property upload: `header.cmd_id == 22`
- Configuration-write acknowledgement: `header.cmd_id == 18`
- Configuration-write command: `header.cmd_id == 17`
- When `header.enc_type == 1 && header.src != 32`, upstream transforms each
  payload byte with `byte XOR (header.seq & 0xff)` before decoding.

Observed configuration-write header values:

| Field | Value |
| --- | ---: |
| `src` | 32 |
| `dest` | 66 |
| `d_src` | 1 |
| `d_dest` | 1 |
| `enc_type` | 1 |
| `check_type` | 3 |
| `cmd_func` | 254 |
| `cmd_id` | 17 |
| `need_ack` | 1 |
| `version` | 3 |
| `payload_ver` | 1 |
| `is_rw_cmd` | 1 |
| `from` | `Android` |
| `data_len` | encoded configuration payload byte length |
| `device_sn` | configured WAVE 3 serial number |
| `pdata` | encoded `Wave3ConfigWrite` payload |

The command sequence is a random integer from 10 through 999 in the upstream
implementation.

**Inference**

- Our codec should accept an explicit sequence number so tests and command
  correlation are deterministic. Runtime controllers randomize their initial
  sequence within the evidenced `10–999` range on every restart, then advance
  sequentially, reducing predictable collisions with the official app.
- Unknown function/command IDs should produce bounded diagnostic results, not
  be decoded as display messages.
- The XOR condition is reverse-engineered behavior, not cryptographic
  protection.

## First-slice state

**Upstream**

| Normalized meaning | Protobuf evidence |
| --- | --- |
| Powered/sleeping | `Wave3DisplayPropertyUpload.dev_sleep_state` (field 212; `1` is treated as off) |
| Operating mode | `wave_operating_mode` (field 486) |
| Ambient temperature | `temp_ambient` (field 484) |
| Ambient humidity | `humi_ambient` (field 485) |
| Indoor supply-air / outlet temperature | `temp_indoor_supply_air` (field 494) |
| Mode-specific state | `wave_mode_info.list_info[wave_operating_mode]` |
| Submode | active mode item's `submode` |
| Airflow speed | active mode item's `airflow_speed` |
| Target temperature | active mode item's `temp_set` |
| Target humidity | active mode item's `humi_set` |
| Automatic upper threshold | active mode item's `temp_thermostatic_upper_limit` |
| Automatic lower threshold | active mode item's `temp_thermostatic_lower_limit` |

Operating modes used upstream:

| Value | Meaning |
| ---: | --- |
| 0 | Off |
| 1 | Cool |
| 2 | Heat |
| 3 | Fan only |
| 4 | Dry |
| 5 | Heat/cool automatic |

Airflow steps used upstream are 20, 40, 60, 80, and 100.
The pinned climate entity advertises a 16–30 °C target range with a 1 °C
target step. Household hardware telemetry later demonstrated that the WAVE 3
accepts and reports fractional targets such as `20.5 °C`, `20.8 °C`, and
`21.8 °C`, even though its physical display shows whole numbers in Celsius
mode. The physical display therefore must not be treated as evidence that the
protocol only supports whole-degree targets.

[Source: household packet evidence shared by Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533272688766877849)
[Told: physical Celsius display observation from Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533523821397545122)

Matter Thermostat represents setpoints in `0.01 °C` units and its
`SetpointRaiseLower` command uses `0.1 °C` units, but the standard cluster has
no attribute that advertises a device-specific setpoint increment. The plugin
can preserve fractional values and clamp them to the 16–30 °C range, but it
cannot tell Apple Home to render a whole-degree-only control. Any future
whole-degree normalization should be an explicit presentation policy rather
than a protocol limitation.

[Source: installed Matter v1.6 Thermostat cluster model · inspected 2026-08-02](../package-lock.json)

Submodes used upstream are normal `0`, boost `2`, sleep `3`, and eco `4`.
Household display packets also repeatedly reported submode `1` for cool and
heat saved-mode parameters. The plugin preserves that value as read-only state
without yet offering it as a command because its user-facing meaning is not
established.

### Runtime firmware versions

The WAVE 3 runtime upload (`cmd_func=254`, `cmd_id=22`) carries packed unsigned
firmware versions:

| Component | Protobuf field |
| --- | ---: |
| PD / primary appliance | `pd_firm_ver` (176) |
| IoT | `iot_firm_ver` (177) |
| MPPT | `mppt_firm_ver` (178) |
| LLC | `llc_firm_ver` (179) |
| BMS | `bms_firm_ver` (241) |

Decode a nonzero value as four big-endian version bytes. The household value
`16842856` is `0x01010068`, therefore `1.1.0.104`. Matter bridged-device
metadata uses PD first and IoT as a fallback; it does not conflate the envelope
header's unrelated protocol `version=3` with device firmware.
[decision: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533305130429059072)

**Inference**

- Household incremental packets reported field 494 falling from about
  `20.13 °C` to `16.60 °C` as cooling ramped. The pinned upstream schema names
  the same field `temp_indoor_supply_air`, so the plugin provisionally exposes
  it as the outlet current-temperature source pending a Home app check.
  [decision: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533304877189431447)
- `dev_sleep_state`, not only `wave_operating_mode`, should govern whether the
  normalized device is powered.
- Display uploads can be incremental. Preserve the reported sleep state,
  operating-mode ID, and per-mode parameter updates in a protobuf-free
  accumulator before deriving the active normalized state. Mode `0` is off
  even when `dev_sleep_state` is `0`.
- The active mode list may be absent, incomplete, or shorter than the mode
  value; decoding must tolerate that without inventing targets.
- Presets, humidity targets, condensate, battery, drainage, and diagnostic
  telemetry are not part of the first Matter climate slice. Dry is exposed as
  the standard Matter thermostat system mode after hardware acceptance.

## First-slice commands

**Upstream**

| Behavior | `Wave3ConfigWrite` field(s) |
| --- | --- |
| Power on | `cfg_main_power = true` |
| Power off | `cfg_sys_pause = true` |
| Select mode | `cfg_main_power = true`, `cfg_wave_operating_mode = mode` |
| Set target temperature | `cfg_temp_set` |
| Set automatic high threshold | `cfg_temp_thermostatic_upper_limit` |
| Set automatic low threshold | `cfg_temp_thermostatic_lower_limit` |
| Set airflow | `cfg_airflow_speed` |

The upstream implementation updates Home Assistant state optimistically before
publishing a command.

**Inference**

- This plugin will not treat optimistic state as authoritative.
- QoS 1 publication is not proof that the WAVE 3 accepted a command.
- The configuration-write acknowledgement includes `actionId`, `configOk`,
  and echoed configuration fields, but the upstream code does not demonstrate
  sequence-based correlation or a complete acceptance policy.
- Acknowledgement correlation and state-confirmation rules must therefore be
  designed and fixture-tested before live commands are attempted.
- A same-sequence acknowledgement whose echoed values do not match the pending
  plugin command is treated as possible foreign-client traffic and ignored.
  EcoFlow may split a composite write into multiple positive same-sequence
  acknowledgement packets. Matching fragments are accumulated; at least one
  positive, command-related fragment is required, but a later authoritative
  display upload may confirm composite fields omitted from acknowledgements.
- When Apple Home stages thermostat values while the appliance is off, the
  subsequent power-on write may combine `cfg_main_power`, mode, and either the
  single-mode target or both automatic thresholds. The controller must confirm
  every included field from the combined acknowledgement and later observed
  state evidence.

## Household hardware observations

**Hardware — 2026-08-01 read-only child-bridge run**

- Authentication against the Americas API, MQTT certification, TLS broker
  connection, five-topic subscription, and initial `latestQuotas` publication
  completed successfully.
- The broker echoed the plugin's property-get publication. No matching
  property-get reply appeared in the captured startup window.
- The WAVE 3 property topic delivered `cmd_func=254`, `cmd_id=21` protobuf
  packets while the official EcoFlow app remained connected.
- The first packet contained recognized ambient-temperature evidence and two
  unknown protobuf fields. The controller became fresh, but its normalized
  state still lacked power, mode, and target settings.
- A later packet contained two unknown protobuf fields and no recognized
  first-slice evidence, so the controller rejected it without regressing the
  previously accepted state.

[Source: household Homebridge diagnostic log shared by Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533270401684082809)

**Hardware — 2026-08-01 official-app setting changes**

- Three official-app fan changes produced positive configuration
  acknowledgements for airflow values `40`, `100`, and `20`, followed by
  display updates with matching active cool-mode airflow values.
- Official-app target changes produced fractional cool-mode values `21.8 °C`
  and `20.8 °C`; the latter also appeared in a positive configuration
  acknowledgement. This disproves the plugin's original whole-degree-only
  assumption.
- A later full display upload supplied sleep state, cool operating mode,
  ambient temperature, ambient humidity, and complete per-mode parameters.
- Display fields `53` and `777` moved together and match upstream power
  telemetry definitions; mode-item field `4` matches the upstream humidity
  target. Neither is required for the first Matter climate slice.

[Source: household Homebridge diagnostic log and narrated app actions shared by Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533272688766877849)

**Hardware — 2026-08-02 composite startup confirmation**

- An Apple Home Off-to-Cool-at-22°C write produced positive same-sequence
  acknowledgements for power and target temperature but no mode
  acknowledgement.
- One second later, display state authoritatively reported power on, Cool mode,
  and a 22°C target. A full display upload repeated the same state three
  seconds later.
- The appliance obeyed the command, but the original all-fields-must-be-echoed
  acknowledgement policy timed out. This confirms that later authoritative
  display state must be allowed to satisfy composite fields omitted from
  positive acknowledgements.

[Source: household Apple Home/Matter diagnostic log shared by Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533523474449039422)

**Hardware — 2026-08-02 delayed mode write and remembered target**

- Apple Home's Off-to-Heat interaction reached the plugin as separate writes:
  the appliance first powered on in its prior Cool/22°C state, then a later
  mode-only Heat command changed `operatingModeId` to `2`.
- Because that Heat command omitted a target, the WAVE 3 selected its stored
  Heat profile target of 26°C and Apple Home later reconciled to 26°C.
- Mode transitions should therefore include the currently presented Matter
  setpoint for Cool or Heat, or both presented thresholds for Auto, even when
  the appliance is already on by the time the mode write is processed.

[Source: household Apple Home/Matter diagnostic log and narrated target selection shared by Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533524342313451610)

**Hardware — 2026-08-01 HomeKit command validation**

- HomeKit target-temperature and power writes worked end to end.
- Rapid HomeKit fan-slider interaction queued confirmed airflow commands for
  `80`, `100`, and a redundant `100`, with an explicit state refresh after
  each command.
- During the fan-write burst, reported power fell to about `1.8 W` and then
  ramped upward again. This is consistent with a control-cycle restart but
  does not by itself prove that the device firmware crashed.
- Fan-slider writes therefore require latest-value coalescing and duplicate
  suppression before further hardware testing.

[Source: household Homebridge diagnostic log and physical observation shared by Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533275994385813545)

**Inference**

- Partial display telemetry is mergeable evidence that the device is
  publishing. A nonzero operating-mode value alone cannot establish a new MQTT
  generation as controllable because household packets proved that saved mode
  `1`/cool can coexist with `dev_sleep_state=1`/off. Initial control state
  therefore requires both sleep state and operating mode; explicit mode `0`
  remains intrinsically off.
- At bridge startup, Matter may retain a complete last-confirmed presentation
  for up to 15 minutes after the bridge last received authoritative state.
  The cached presentation is read-only: writes still require authoritative
  online state from the current MQTT generation. If the cache is missing or
  older than 15 minutes, or if that grace period expires before fresh state
  arrives, publish `BridgedDeviceBasicInformation.reachable = false` so the
  controller reports No Response. Fresh authoritative state restores
  reachability and starts a new cache window. Explicit device-offline and
  account/session-error evidence bypasses the grace period and becomes
  unreachable immediately.
- Once current-generation state is established, allow five minutes without
  recognized authoritative telemetry before marking it stale. The household
  WAVE normally sends a full display upload about every two minutes; the
  longer window avoids racing that cadence while still detecting sustained
  silence. Command confirmation retains its independent ten-second deadline.

[Decision: Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533514045766897795), superseding the broader 2026-08-01 cached-availability rule.
[Freshness decision: Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533535457453932654)

**Hardware — 2026-08-02 Matter off-to-on sequencing**

- Apple Home accepted a Cool target of `20 °C` while the WAVE was off, but the
  plugin rejected that setpoint as inactive and sent only `cfg_main_power =
  true` when Home subsequently powered the accessory on.
- The WAVE correctly resumed its saved Cool target of `26 °C`; no `20 °C`
  configuration write appeared in the EcoFlow diagnostics. Repeating the Home
  interaction with Auto produced the same sequencing failure.
- Matter mode and setpoint attributes selected while off must therefore be
  staged locally. The later authoritative OnOff command sends one composite
  configuration write containing main power, the staged mode, and its staged
  target or automatic range. The controller still requires matching positive
  acknowledgement fragments and later observed state for every included field.

[Source: household Matter/Homebridge diagnostic log and narrated Apple Home actions shared by Julian · 2026-08-02](https://discord.com/channels/1499872194610598249/1531866537185640448/1533508417145147622)

## Known uncertainty

- No private device-list endpoint is evidenced by the pinned upstream code.
- The exact semantics of `actionId`, `configOk`, and acknowledgement sequence
  correlation remain unverified.
- Upstream discussion reports that some WAVE 3 installations stop accepting
  commands after an extended session. The cause and safe recovery behavior
  remain unverified.
- Basic official-app and plugin connection coexistence has been observed once;
  reconnect and extended-session reliability remain unverified.
- All field meanings remain reverse-engineered until household hardware
  validation.

## Port boundary

The first port may include only:

- the outer envelope and header
- the first-slice fields listed above
- display, runtime, configuration-write, and acknowledgement message shapes
  needed to decode or encode that slice
- typed normalized state and commands

Do not copy unrelated WAVE 3 power, battery, timers, Pet Care, display,
drainage, firmware, or diagnostic fields merely because they exist in the
upstream schema.
