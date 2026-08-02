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
does not yet establish supported HomeKit controls.

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
- The first slice retains the pinned client's five-topic subscription shape;
  narrowing it to inbound-only topics requires broker or hardware evidence.
- Every reconnect should re-subscribe and refresh exactly once.
- MQTT setup completing means only that the cloud transport is ready. The
  controller remains stale and rejects writes until current-generation WAVE 3
  climate evidence arrives. A valid `latestQuotas` get reply supplies that
  evidence; `data.online == 0` makes the device unavailable, and malformed
  replies do not revive cached pre-reconnect state.
- Each refresh keeps its generated request ID until one matching get reply is
  consumed. A newer refresh, reconnect, or intervening validated display update
  with a newer device sequence supersedes the pending reply so delayed quota
  snapshots cannot regress the current connection generation. Runtime,
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
  correlation are deterministic.
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
target step. Household hardware telemetry later demonstrated fractional target
temperatures, so the HomeKit surface uses a 0.1 °C step within the same range.
Submodes used upstream are normal `0`, boost `2`, sleep `3`, and eco `4`.

**Inference**

- `dev_sleep_state`, not only `wave_operating_mode`, should govern whether the
  normalized device is powered.
- Display uploads can be incremental. Preserve the reported sleep state,
  operating-mode ID, and per-mode parameter updates in a protobuf-free
  accumulator before deriving the active normalized state. Mode `0` is off
  even when `dev_sleep_state` is `0`.
- The active mode list may be absent, incomplete, or shorter than the mode
  value; decoding must tolerate that without inventing targets.
- Dry, presets, humidity targets, condensate, battery, drainage, and
  diagnostic telemetry are not part of the first HomeKit slice.

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
  target. None is required for the first HomeKit climate slice.

[Source: household Homebridge diagnostic log and narrated app actions shared by Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533272688766877849)

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

- Unknown field numbers and wire types are needed before deciding whether the
  packets contain missing climate state or unrelated incremental telemetry.
- Ambient temperature alone is insufficient for a usable `HeaterCooler`
  snapshot even though it proves current-generation device communication.
- HomeKit should retain a complete last-confirmed presentation through
  transient stale, reconnecting, and device-offline states. Writes must still
  require current online state; a startup that never obtains trustworthy
  device state or an explicit account/session failure should continue to
  report communication failure.

[Decision: Julian · 2026-08-01](https://discord.com/channels/1499872194610598249/1531866537185640448/1533277123425472562)

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
