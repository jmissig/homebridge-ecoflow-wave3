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
  encodeWave3Command,
  transformWave3Payload,
} from '../src/wave3/codec.js';
import type { Wave3Command } from '../src/wave3/domain.js';

describe('WAVE 3 codec', () => {
  it('decodes an XOR-transformed display upload into normalized state', () => {
    const display = create(Wave3DisplayPropertyUploadSchema, {
      devSleepState: 0,
      tempAmbient: 23.5,
      humiAmbient: 54,
      waveOperatingMode: 1,
      waveModeInfo: {
        listInfo: [
          {},
          {
            submode: 2,
            airflowSpeed: 60,
            tempSet: 21,
            humiSet: 50,
            tempThermostaticLowerLimit: 19,
            tempThermostaticUpperLimit: 24,
          },
        ],
      },
    });
    const plainPayload = toBinary(Wave3DisplayPropertyUploadSchema, display);
    const sequence = 37;
    const transformedPayload = transformWave3Payload(plainPayload, 1, 66, sequence);

    const decoded = decodeWave3Message(envelope(1, sequence, transformedPayload, {
      encryptionType: 1,
      source: 66,
    }));

    assert.equal(decoded.kind, 'display');
    if (decoded.kind !== 'display') {
      return;
    }
    assert.deepEqual(decoded.state, {
      sleeping: false,
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 23.5,
      ambientHumidityPercent: 54,
      targetTemperatureCelsius: 21,
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
      targetHumidityPercent: 50,
      airflowSpeed: 60,
      submode: 2,
    });
    assert.equal(decoded.sequence, sequence);
  });

  it('does not invent absent proto2 scalar fields', () => {
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
      assert.deepEqual(decoded.state, { mode: 'auto' });
    }
  });

  it('decodes bounded runtime telemetry independently of normalized climate state', () => {
    const runtime = create(Wave3RuntimePropertyUploadSchema, {
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
    }
  });

  it('decodes a configuration acknowledgement and preserves its sequence', () => {
    const acknowledgement = create(Wave3ConfigWriteAckSchema, {
      actionId: 91,
      configOk: true,
      cfgWaveOperatingMode: 2,
      cfgTempSet: 24,
    });

    const decoded = decodeWave3Message(envelope(
      18,
      91,
      toBinary(Wave3ConfigWriteAckSchema, acknowledgement),
    ));

    assert.equal(decoded.kind, 'acknowledgement');
    if (decoded.kind === 'acknowledgement') {
      assert.equal(decoded.sequence, 91);
      assert.deepEqual(decoded.acknowledgement, {
        actionId: 91,
        accepted: true,
        values: {
          mode: 'heat',
          targetTemperatureCelsius: 24,
        },
      });
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
      assert.equal(message.header?.dataLen, message.header?.pdata.length);

      const config = fromBinary(Wave3ConfigWriteSchema, message.header?.pdata ?? new Uint8Array());
      const actual = Object.fromEntries(
        Object.keys(expected).map(key => [key, config[key as keyof typeof config]]),
      );
      assert.deepEqual(actual, expected);
    }
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
  });

  it('counts unknown protobuf fields without exposing their bytes', () => {
    const display = create(Wave3DisplayPropertyUploadSchema, { tempAmbient: 20 });
    const payload = concatenate(
      toBinary(Wave3DisplayPropertyUploadSchema, display),
      encodeVarint((700 << 3) | 0),
      encodeVarint(7),
    );
    const decoded = decodeWave3Message(envelope(1, 51, payload));

    assert.equal(decoded.kind, 'display');
    assert.equal(decoded.diagnostic.unknownFieldCount, 1);
    assert.deepEqual(Object.keys(decoded.diagnostic).sort(), [
      'commandFunction',
      'commandId',
      'payloadLength',
      'sequence',
      'unknownFieldCount',
    ]);
  });
});

function envelope(
  commandId: number,
  sequence: number,
  payload: Uint8Array,
  options: { encryptionType?: number; source?: number } = {},
): Uint8Array {
  const message = create(Wave3SetMessageSchema, {
    header: {
      pdata: payload,
      src: options.source ?? 32,
      encType: options.encryptionType ?? 0,
      cmdFunc: 254,
      cmdId: commandId,
      dataLen: payload.length,
      seq: sequence,
    },
  });
  assert.equal(isFieldSet(message.header!, Wave3SetHeaderSchema.field.dataLen), true);
  return toBinary(Wave3SetMessageSchema, message);
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
