import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { create, fromBinary, isFieldSet, toBinary } from '@bufbuild/protobuf';

import {
  Wave3ConfigWriteAckSchema,
  Wave3ConfigWriteSchema,
  Wave3DisplayPropertyUploadSchema,
  Wave3RuntimePropertyUploadSchema,
  Wave3SetHeaderSchema,
  Wave3SetMessageSchema,
} from '../src/proto/gen/ecoflow/wave3/v1/wave3_pb.js';
import {
  decodeWave3Message,
  decodeWave3QuotaReply,
  encodeWave3Command,
  mergeWave3DisplayUpdate,
  packedFirmwareVersion,
  transformWave3Payload,
} from '../src/wave3/codec.js';
import type { Wave3Command } from '../src/wave3/domain.js';

// Produced with the pinned upstream wave3_pb2.py at commit
// 95dc51eb12562c49be9067052814d5960cc0829f, not with this repository's schema.
const GOLDEN_DISPLAY_PACKET_HEX =
  '0a3b0a2ca00d00a51e0000bc41ad1e00005842b01e019220170a000a130802103c1d0000a8412d0000c04135000098411020300040fe014801502c7025';
const GOLDEN_COOL_COMMAND_HEX =
  '0a450a052001c8090110201842200128013001380340fe01481150055801707b800103880101980101ba0107416e64726f6964ca0111544553542d57415645332d53455249414c';

describe('WAVE 3 codec', () => {
  it('decodes an upstream-generated golden display packet into merge-safe state', () => {
    const decoded = decodeWave3Message(hexToBytes(GOLDEN_DISPLAY_PACKET_HEX));

    assert.equal(decoded.kind, 'display');
    if (decoded.kind !== 'display') {
      return;
    }
    assert.deepEqual(decoded.update, {
      sleepState: 0,
      operatingModeId: 1,
      ambientTemperatureCelsius: 23.5,
      ambientHumidityPercent: 54,
      modeParameters: {
        1: {
          submode: 2,
          airflowSpeed: 60,
          targetTemperatureCelsius: 21,
          targetTemperatureLowerCelsius: 19,
          targetTemperatureUpperCelsius: 24,
        },
      },
    });
    assert.deepEqual(mergeWave3DisplayUpdate(undefined, decoded.update).state, {
      sleeping: false,
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 23.5,
      ambientHumidityPercent: 54,
      targetTemperatureCelsius: 21,
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
      airflowSpeed: 60,
      submode: 2,
    });
    assert.equal(decoded.sequence, 37);
  });

  it('does not invent absent optional scalar fields', () => {
    const display = create(Wave3DisplayPropertyUploadSchema, {
      waveOperatingMode: 5,
    });

    const decoded = decodeWave3Message(envelope(
      21,
      44,
      toBinary(Wave3DisplayPropertyUploadSchema, display),
    ));

    assert.equal(decoded.kind, 'display');
    if (decoded.kind === 'display') {
      assert.deepEqual(decoded.update, {
        operatingModeId: 5,
        modeParameters: {},
      });
      assert.deepEqual(mergeWave3DisplayUpdate(undefined, decoded.update).state, {
        mode: 'auto',
        powered: true,
      });
    }
  });

  it('decodes field 494 as the provisionally identified indoor supply-air temperature', () => {
    const display = create(Wave3DisplayPropertyUploadSchema, {
      tempIndoorSupplyAir: 16.6,
    });
    const decoded = decodeWave3Message(envelope(
      21,
      45,
      toBinary(Wave3DisplayPropertyUploadSchema, display),
    ));

    assert.equal(decoded.kind, 'display');
    if (decoded.kind === 'display') {
      assert.ok(Math.abs((decoded.update.outletTemperatureCelsius ?? 0) - 16.6) < 0.0001);
      assert.ok(Math.abs((mergeWave3DisplayUpdate(
        undefined,
        decoded.update,
      ).state.outletTemperatureCelsius ?? 0) - 16.6) < 0.0001);
    }
  });

  it('retains household-observed read-only submode 1 from display and quota state', () => {
    const display = create(Wave3DisplayPropertyUploadSchema, {
      waveOperatingMode: 1,
      waveModeInfo: {
        listInfo: [{}, { submode: 1 }],
      },
    });
    const decodedDisplay = decodeWave3Message(envelope(
      21,
      45,
      toBinary(Wave3DisplayPropertyUploadSchema, display),
    ));
    assert.equal(decodedDisplay.kind, 'display');
    if (decodedDisplay.kind === 'display') {
      assert.equal(decodedDisplay.update.modeParameters[1]?.submode, 1);
      assert.equal(
        mergeWave3DisplayUpdate(undefined, decodedDisplay.update).state.submode,
        1,
      );
    }

    const decodedQuota = decodeWave3QuotaReply(jsonBytes({
      operateType: 'latestQuotas',
      data: {
        online: 1,
        quotaMap: {
          wave_operating_mode: 1,
          current_submode: 1,
        },
      },
    }));
    assert.equal(decodedQuota.kind, 'quota');
    if (decodedQuota.kind === 'quota') {
      assert.equal(decodedQuota.update?.modeParameters[1]?.submode, 1);
    }
  });

  it('derives OFF from mode zero and preserves mode parameters across incremental packets', () => {
    const off = create(Wave3DisplayPropertyUploadSchema, {
      devSleepState: 0,
      waveOperatingMode: 0,
    });
    const decodedOff = decodeWave3Message(envelope(
      1,
      40,
      toBinary(Wave3DisplayPropertyUploadSchema, off),
    ));
    assert.equal(decodedOff.kind, 'display');
    if (decodedOff.kind !== 'display') {
      return;
    }
    assert.deepEqual(mergeWave3DisplayUpdate(undefined, decodedOff.update).state, {
      sleeping: false,
      mode: 'off',
      powered: false,
    });

    const initial = decodeWave3Message(hexToBytes(GOLDEN_DISPLAY_PACKET_HEX));
    assert.equal(initial.kind, 'display');
    if (initial.kind !== 'display') {
      return;
    }
    const prior = mergeWave3DisplayUpdate(undefined, initial.update);
    const incremental = create(Wave3DisplayPropertyUploadSchema, {
      waveModeInfo: {
        listInfo: [{}, { tempSet: 20.8 }],
      },
    });
    const decodedIncremental = decodeWave3Message(envelope(
      21,
      41,
      toBinary(Wave3DisplayPropertyUploadSchema, incremental),
    ));
    assert.equal(decodedIncremental.kind, 'display');
    if (decodedIncremental.kind === 'display') {
      const merged = mergeWave3DisplayUpdate(prior, decodedIncremental.update);
      assert.equal(merged.state.mode, 'cool');
      assert.ok(Math.abs((merged.state.targetTemperatureCelsius ?? 0) - 20.8) < 0.0001);
      assert.equal(merged.state.airflowSpeed, 60);
    }
  });

  it('decodes bounded runtime telemetry independently of normalized climate state', () => {
    const runtime = create(Wave3RuntimePropertyUploadSchema, {
      pdFirmVer: 16_842_856,
      iotFirmVer: 16_842_856,
      mpptFirmVer: 0,
      tempIndoorReturnAir: 22.25,
      tempCondenser: 40.5,
    });

    const decoded = decodeWave3Message(envelope(
      22,
      45,
      toBinary(Wave3RuntimePropertyUploadSchema, runtime),
    ));

    assert.equal(decoded.kind, 'runtime');
    if (decoded.kind === 'runtime') {
      assert.deepEqual(decoded.temperatures, {
        indoorReturnAirCelsius: 22.25,
        condenserCelsius: 40.5,
      });
      assert.deepEqual(decoded.firmwareVersions, {
        pd: '1.1.0.104',
        iot: '1.1.0.104',
      });
    }
    assert.equal(packedFirmwareVersion(16_842_856), '1.1.0.104');
  });

  it('strictly decodes latest-quota JSON into a merge-safe display update', () => {
    const decoded = decodeWave3QuotaReply(jsonBytes({
      operateType: 'latestQuotas',
      data: {
        online: '1',
        quotaMap: {
          dev_sleep_state: 0,
          wave_operating_mode: 5,
          temp_ambient: 23,
          humi_ambient: 48,
          temp_indoor_supply_air: 18,
          current_temp_lower: 19,
          current_temp_upper: 25,
          current_airflow_speed: 60,
          current_submode: 3,
        },
      },
    }));
    assert.deepEqual(decoded, {
      kind: 'quota',
      deviceOnline: true,
      update: {
        sleepState: 0,
        operatingModeId: 5,
        ambientTemperatureCelsius: 23,
        ambientHumidityPercent: 48,
        outletTemperatureCelsius: 18,
        modeParameters: {
          5: {
            targetTemperatureLowerCelsius: 19,
            targetTemperatureUpperCelsius: 25,
            airflowSpeed: 60,
            submode: 3,
          },
        },
      },
    });
    if (decoded.kind === 'quota' && decoded.update !== undefined) {
      assert.deepEqual(mergeWave3DisplayUpdate(undefined, decoded.update).state, {
        sleeping: false,
        powered: true,
        mode: 'auto',
        ambientTemperatureCelsius: 23,
        ambientHumidityPercent: 48,
        outletTemperatureCelsius: 18,
        targetTemperatureLowerCelsius: 19,
        targetTemperatureUpperCelsius: 25,
        airflowSpeed: 60,
        submode: 3,
      });
    }

    assert.deepEqual(decodeWave3QuotaReply(jsonBytes({
      operateType: 'latestQuotas',
      data: { online: 0 },
    })), {
      kind: 'quota',
      deviceOnline: false,
    });
    assert.equal(
      decodeWave3QuotaReply(jsonBytes({
        operateType: 'latestQuotas',
        data: {
          online: 1,
          quotaMap: { temp_ambient: '23' },
        },
      })).kind,
      'malformed',
    );
    assert.equal(
      decodeWave3QuotaReply(jsonBytes({
        operateType: 'latestQuotas',
        data: {
          online: 1,
          quotaMap: { temp_ambient: 23 },
        },
      })).kind,
      'malformed',
    );
    for (const quotaMap of [
      {
        wave_operating_mode: 1,
        temp_ambient: 1_000_000_000,
      },
      {
        wave_operating_mode: 1,
        humi_ambient: -4,
      },
      {
        wave_operating_mode: 5,
        current_temp_lower: 29,
        current_temp_upper: 17,
      },
    ]) {
      assert.equal(
        decodeWave3QuotaReply(jsonBytes({
          operateType: 'latestQuotas',
          data: { online: 1, quotaMap },
        })).kind,
        'malformed',
      );
    }
  });

  it('reports configOk without conflating action ID and envelope sequence', () => {
    for (const [configOk, expected] of [
      [true, true],
      [false, false],
      [undefined, undefined],
    ] as const) {
      const acknowledgement = create(Wave3ConfigWriteAckSchema, {
        actionId: 91,
        configOk,
        cfgWaveOperatingMode: 2,
        cfgTempSet: 24,
      });
      const decoded = decodeWave3Message(envelope(
        18,
        92,
        toBinary(Wave3ConfigWriteAckSchema, acknowledgement),
      ));

      assert.equal(decoded.kind, 'acknowledgement');
      if (decoded.kind === 'acknowledgement') {
        assert.equal(decoded.sequence, 92);
        assert.deepEqual(decoded.acknowledgement, {
          actionId: 91,
          reportedConfigOk: expected,
          values: {
            mode: 'heat',
            targetTemperatureCelsius: 24,
          },
        });
      }
    }
  });

  it('encodes every first-slice command in the reviewed write envelope', () => {
    const cases: Array<{
      command: Wave3Command;
      expected: Record<string, boolean | number>;
    }> = [
      { command: { type: 'power', on: true }, expected: { cfgMainPower: true } },
      { command: { type: 'power', on: false }, expected: { cfgSysPause: true } },
      { command: { type: 'mode', mode: 'cool' }, expected: { cfgMainPower: true, cfgWaveOperatingMode: 1 } },
      { command: { type: 'mode', mode: 'heat' }, expected: { cfgMainPower: true, cfgWaveOperatingMode: 2 } },
      { command: { type: 'mode', mode: 'fan' }, expected: { cfgMainPower: true, cfgWaveOperatingMode: 3 } },
      { command: { type: 'mode', mode: 'dry' }, expected: { cfgMainPower: true, cfgWaveOperatingMode: 4 } },
      { command: { type: 'mode', mode: 'auto' }, expected: { cfgMainPower: true, cfgWaveOperatingMode: 5 } },
      { command: { type: 'targetTemperature', celsius: 22 }, expected: { cfgTempSet: 22 } },
      {
        command: { type: 'automaticTemperatureRange', lowerCelsius: 19, upperCelsius: 25 },
        expected: { cfgTempThermostaticLowerLimit: 19, cfgTempThermostaticUpperLimit: 25 },
      },
      { command: { type: 'airflowSpeed', speed: 80 }, expected: { cfgAirflowSpeed: 80 } },
      { command: { type: 'submode', submode: 3 }, expected: { cfgWaveOperatingSubmode: 3 } },
    ];

    for (const { command, expected } of cases) {
      const encoded = encodeWave3Command('TEST-WAVE3-SERIAL', 123, command);
      const message = fromBinary(Wave3SetMessageSchema, encoded.bytes);
      assert.equal(encoded.sequence, 123);
      assert.equal(message.header?.src, 32);
      assert.equal(message.header?.dest, 66);
      assert.equal(message.header?.cmdFunc, 254);
      assert.equal(message.header?.cmdId, 17);
      assert.equal(message.header?.needAck, 1);
      assert.equal(message.header?.seq, 123);
      assert.equal(message.header?.deviceSn, 'TEST-WAVE3-SERIAL');
      assert.equal(message.header?.dataLen, message.header?.pdata?.length);

      const config = fromBinary(Wave3ConfigWriteSchema, message.header?.pdata ?? new Uint8Array());
      const actual = Object.fromEntries(
        Object.keys(expected).map(key => [key, config[key as keyof typeof config]]),
      );
      assert.deepEqual(actual, expected);
    }

    assert.equal(
      bytesToHex(encodeWave3Command(
        'TEST-WAVE3-SERIAL',
        123,
        { type: 'mode', mode: 'cool' },
      ).bytes),
      GOLDEN_COOL_COMMAND_HEX,
    );
  });

  it('validates caller-supplied command boundaries', () => {
    assert.throws(
      () => encodeWave3Command('', 20, { type: 'power', on: true }),
      /serial/,
    );
    assert.throws(
      () => encodeWave3Command('TEST', 9, { type: 'power', on: true }),
      /sequence/,
    );
    assert.throws(
      () => encodeWave3Command('TEST', 20, { type: 'targetTemperature', celsius: 31 }),
      /temperature/,
    );
    assert.throws(
      () => encodeWave3Command('TEST', 20, { type: 'targetTemperature', celsius: 22.55 }),
      /0.1 degree steps/,
    );
    const fractionalEnvelope = fromBinary(
      Wave3SetMessageSchema,
      encodeWave3Command('TEST', 20, { type: 'targetTemperature', celsius: 20.8 }).bytes,
    );
    const fractional = fromBinary(
      Wave3ConfigWriteSchema,
      fractionalEnvelope.header?.pdata ?? new Uint8Array(),
    );
    assert.ok(Math.abs((fractional.cfgTempSet ?? 0) - 20.8) < 0.0001);
    assert.throws(
      () => encodeWave3Command('TEST', 20, {
        type: 'automaticTemperatureRange',
        lowerCelsius: 24,
        upperCelsius: 20,
      }),
      /lower bound/,
    );
  });

  it('returns bounded diagnostics for unknown, malformed, and mismatched packets', () => {
    const unknown = decodeWave3Message(envelope(99, 77, Uint8Array.of(1, 2, 3)));
    assert.deepEqual(unknown, {
      kind: 'unknown',
      diagnostic: {
        commandFunction: 254,
        commandId: 99,
        sequence: 77,
        payloadLength: 3,
        unknownFieldCount: 0,
      },
    });

    const malformed = decodeWave3Message(Uint8Array.of(0x0a));
    assert.equal(malformed.kind, 'malformed');
    assert.equal(malformed.diagnostic.payloadLength, 1);
    assert.equal(malformed.diagnostic.reason, 'truncated protobuf message');

    const mismatchMessage = create(Wave3SetMessageSchema, {
      header: {
        cmdFunc: 254,
        cmdId: 1,
        seq: 88,
        dataLen: 99,
        pdata: Uint8Array.of(1),
      },
    });
    const mismatch = decodeWave3Message(toBinary(Wave3SetMessageSchema, mismatchMessage));
    assert.equal(mismatch.kind, 'malformed');
    assert.equal(mismatch.diagnostic.reason, 'payload length mismatch');
    assert.equal('payload' in mismatch.diagnostic, false);

    const wrongFunction = decodeWave3Message(envelope(
      1,
      89,
      Uint8Array.of(1),
      { commandFunction: 7 },
    ));
    assert.equal(wrongFunction.kind, 'unknown');
    assert.equal(wrongFunction.diagnostic.commandFunction, 7);
  });

  it('reports unsupported values and bounded unknown-field metadata without exposing bytes', () => {
    const display = create(Wave3DisplayPropertyUploadSchema, { tempAmbient: 20 });
    const payload = concatenate(
      toBinary(Wave3DisplayPropertyUploadSchema, display),
      encodeVarint((700 << 3) | 0),
      encodeVarint(7),
    );
    const packetWithPayloadUnknown = envelope(1, 51, payload);
    const decoded = decodeWave3Message(concatenate(
      packetWithPayloadUnknown,
      encodeVarint((701 << 3) | 0),
      encodeVarint(8),
    ));

    assert.equal(decoded.kind, 'display');
    assert.equal(decoded.diagnostic.unknownFieldCount, 2);
    assert.deepEqual(decoded.diagnostic.unknownFields, [
      {
        scope: 'envelope',
        number: 701,
        wireType: 'varint',
        dataLength: 1,
      },
      {
        scope: 'payload',
        number: 700,
        wireType: 'varint',
        dataLength: 1,
        scalarCandidates: {
          unsigned: '7',
        },
      },
    ]);
    assert.equal(JSON.stringify(decoded.diagnostic).includes('"data"'), false);

    const unknownMode = create(Wave3DisplayPropertyUploadSchema, {
      waveOperatingMode: 99,
    });
    const decodedUnknownMode = decodeWave3Message(envelope(
      1,
      52,
      toBinary(Wave3DisplayPropertyUploadSchema, unknownMode),
    ));
    assert.equal(decodedUnknownMode.kind, 'display');
    assert.deepEqual(decodedUnknownMode.diagnostic.unsupportedValues, [
      { field: 'wave_operating_mode', value: 99 },
    ]);

    const unknownAckMode = create(Wave3ConfigWriteAckSchema, {
      cfgWaveOperatingMode: 99,
    });
    const decodedUnknownAckMode = decodeWave3Message(envelope(
      18,
      53,
      toBinary(Wave3ConfigWriteAckSchema, unknownAckMode),
    ));
    assert.equal(decodedUnknownAckMode.kind, 'acknowledgement');
    assert.deepEqual(decodedUnknownAckMode.diagnostic.unsupportedValues, [
      { field: 'cfg_wave_operating_mode', value: 99 },
    ]);
  });

  it('omits invalid HomeKit-facing telemetry with bounded diagnostics', () => {
    const display = create(Wave3DisplayPropertyUploadSchema, {
      tempAmbient: Number.POSITIVE_INFINITY,
      humiAmbient: 101,
      waveOperatingMode: 1,
      waveModeInfo: {
        listInfo: [
          {},
          {
            airflowSpeed: 41,
            tempSet: 99,
            tempThermostaticLowerLimit: 15,
            tempThermostaticUpperLimit: 31,
            submode: 7,
          },
        ],
      },
    });
    const decoded = decodeWave3Message(envelope(
      21,
      54,
      toBinary(Wave3DisplayPropertyUploadSchema, display),
    ));
    assert.equal(decoded.kind, 'display');
    if (decoded.kind !== 'display') {
      return;
    }
    assert.deepEqual(decoded.update, {
      operatingModeId: 1,
      modeParameters: {},
    });
    assert.deepEqual(mergeWave3DisplayUpdate(undefined, decoded.update).state, {
      powered: true,
      mode: 'cool',
    });
    assert.deepEqual(
      decoded.diagnostic.unsupportedValues?.map(value => value.field),
      [
        'temp_ambient',
        'humi_ambient',
        'wave_mode_info[1].submode',
        'wave_mode_info[1].airflow_speed',
        'wave_mode_info[1].temp_set',
        'wave_mode_info[1].temp_thermostatic_lower_limit',
        'wave_mode_info[1].temp_thermostatic_upper_limit',
      ],
    );
  });

  it('applies XOR only when both evidenced conditions hold', () => {
    const payload = Uint8Array.of(0x10, 0x20, 0x30);
    assert.strictEqual(transformWave3Payload(payload, 0, 66, 17), payload);
    assert.strictEqual(transformWave3Payload(payload, 1, 32, 17), payload);
    assert.deepEqual(
      transformWave3Payload(payload, 1, 66, 17),
      Uint8Array.of(0x01, 0x31, 0x21),
    );

    const decoded = decodeWave3Message(envelope(
      1,
      17,
      hexToBytes('b40f1111b150'),
      { encryptionType: 1, source: 66 },
    ));
    assert.equal(decoded.kind, 'display');
    if (decoded.kind === 'display') {
      assert.equal(decoded.update.ambientTemperatureCelsius, 20);
    }
  });
});

function envelope(
  commandId: number,
  sequence: number,
  payload: Uint8Array,
  options: {
    commandFunction?: number;
    encryptionType?: number;
    source?: number;
  } = {},
): Uint8Array {
  const message = create(Wave3SetMessageSchema, {
    header: {
      pdata: payload,
      src: options.source ?? 32,
      encType: options.encryptionType ?? 0,
      cmdFunc: options.commandFunction ?? 254,
      cmdId: commandId,
      dataLen: payload.length,
      seq: sequence,
    },
  });
  assert.equal(isFieldSet(message.header!, Wave3SetHeaderSchema.field.dataLen), true);
  return toBinary(Wave3SetMessageSchema, message);
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function concatenate(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((length, array) => length + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}
