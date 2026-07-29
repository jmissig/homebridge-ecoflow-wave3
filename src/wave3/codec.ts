import {
  create,
  fromBinary,
  isFieldSet,
  toBinary,
  type DescMessage,
  type MessageShape,
} from '@bufbuild/protobuf';

import {
  Wave3ConfigWriteAckSchema,
  Wave3ConfigWriteSchema,
  Wave3DisplayPropertyUploadSchema,
  Wave3RuntimePropertyUploadSchema,
  Wave3SetHeaderSchema,
  Wave3SetMessageSchema,
  Wave3WaveOperatingModeParamItemSchema,
} from '../proto/gen/ecoflow/wave3/v1/wave3_pb.js';
import {
  WAVE3_MODE_IDS,
  type Wave3AcknowledgedValues,
  type Wave3Acknowledgement,
  type Wave3Command,
  type Wave3Mode,
  type Wave3RuntimeTemperatures,
  type Wave3State,
} from './domain.js';

const WAVE3_COMMAND_FUNCTION = 254;
const DISPLAY_COMMAND_IDS = new Set([1, 21]);
const ACK_COMMAND_ID = 18;
const RUNTIME_COMMAND_ID = 22;

const WAVE3_MODE_BY_ID = new Map<number, Wave3Mode>(
  Object.entries(WAVE3_MODE_IDS).map(([mode, id]) => [id, mode as Wave3Mode]),
);

export interface Wave3Diagnostic {
  commandFunction?: number;
  commandId?: number;
  sequence?: number;
  payloadLength: number;
  unknownFieldCount?: number;
  reason?: string;
}

export type DecodedWave3Message =
  | {
    kind: 'display';
    sequence: number;
    state: Wave3State;
    diagnostic: Wave3Diagnostic;
  }
  | {
    kind: 'runtime';
    sequence: number;
    temperatures: Wave3RuntimeTemperatures;
    diagnostic: Wave3Diagnostic;
  }
  | {
    kind: 'acknowledgement';
    sequence: number;
    acknowledgement: Wave3Acknowledgement;
    diagnostic: Wave3Diagnostic;
  }
  | {
    kind: 'unknown';
    diagnostic: Wave3Diagnostic;
  }
  | {
    kind: 'malformed';
    diagnostic: Wave3Diagnostic;
  };

export interface EncodedWave3Command {
  sequence: number;
  bytes: Uint8Array;
}

export function decodeWave3Message(bytes: Uint8Array): DecodedWave3Message {
  try {
    const message = fromBinary(Wave3SetMessageSchema, bytes);
    const header = message.header;

    if (header === undefined) {
      return malformed(bytes.length, 'missing envelope header');
    }

    const diagnostic = {
      commandFunction: header.cmdFunc,
      commandId: header.cmdId,
      sequence: header.seq,
      payloadLength: header.pdata.length,
      unknownFieldCount: header.$unknown?.length ?? 0,
    };

    if (header.pdata.length === 0) {
      return { kind: 'malformed', diagnostic: { ...diagnostic, reason: 'missing payload' } };
    }

    if (isFieldSet(header, Wave3SetHeaderSchema.field.dataLen)
      && header.dataLen !== header.pdata.length) {
      return { kind: 'malformed', diagnostic: { ...diagnostic, reason: 'payload length mismatch' } };
    }

    const payload = transformWave3Payload(header.pdata, header.encType, header.src, header.seq);

    if (header.cmdFunc !== WAVE3_COMMAND_FUNCTION) {
      return { kind: 'unknown', diagnostic };
    }

    if (DISPLAY_COMMAND_IDS.has(header.cmdId)) {
      const display = fromBinary(Wave3DisplayPropertyUploadSchema, payload);
      return {
        kind: 'display',
        sequence: header.seq,
        state: normalizeDisplayState(display),
        diagnostic: withPayloadUnknownCount(diagnostic, display),
      };
    }

    if (header.cmdId === RUNTIME_COMMAND_ID) {
      const runtime = fromBinary(Wave3RuntimePropertyUploadSchema, payload);
      return {
        kind: 'runtime',
        sequence: header.seq,
        temperatures: normalizeRuntimeTemperatures(runtime),
        diagnostic: withPayloadUnknownCount(diagnostic, runtime),
      };
    }

    if (header.cmdId === ACK_COMMAND_ID) {
      const acknowledgement = fromBinary(Wave3ConfigWriteAckSchema, payload);
      return {
        kind: 'acknowledgement',
        sequence: header.seq,
        acknowledgement: normalizeAcknowledgement(acknowledgement),
        diagnostic: withPayloadUnknownCount(diagnostic, acknowledgement),
      };
    }

    return { kind: 'unknown', diagnostic };
  } catch (error) {
    return malformed(bytes.length, boundedErrorReason(error));
  }
}

export function encodeWave3Command(
  deviceSerial: string,
  sequence: number,
  command: Wave3Command,
): EncodedWave3Command {
  validateDeviceSerial(deviceSerial);
  validateSequence(sequence);

  const config = create(Wave3ConfigWriteSchema, commandToConfig(command));
  const payload = toBinary(Wave3ConfigWriteSchema, config);
  const message = create(Wave3SetMessageSchema, {
    header: {
      pdata: payload,
      src: 32,
      dest: 66,
      dSrc: 1,
      dDest: 1,
      encType: 1,
      checkType: 3,
      cmdFunc: WAVE3_COMMAND_FUNCTION,
      cmdId: 17,
      dataLen: payload.length,
      needAck: 1,
      seq: sequence,
      version: 3,
      payloadVer: 1,
      isRwCmd: 1,
      from: 'Android',
      deviceSn: deviceSerial,
    },
  });

  return {
    sequence,
    bytes: toBinary(Wave3SetMessageSchema, message),
  };
}

export function transformWave3Payload(
  payload: Uint8Array,
  encryptionType: number,
  source: number,
  sequence: number,
): Uint8Array {
  if (encryptionType !== 1 || source === 32) {
    return payload;
  }

  const key = sequence & 0xff;
  return Uint8Array.from(payload, byte => byte ^ key);
}

function normalizeDisplayState(
  display: MessageShape<typeof Wave3DisplayPropertyUploadSchema>,
): Wave3State {
  const state: Wave3State = {};

  if (has(display, Wave3DisplayPropertyUploadSchema, 'devSleepState')) {
    state.sleeping = display.devSleepState === 1;
    state.powered = display.devSleepState !== 1;
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'tempAmbient')) {
    state.ambientTemperatureCelsius = display.tempAmbient;
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'humiAmbient')) {
    state.ambientHumidityPercent = display.humiAmbient;
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'waveOperatingMode')) {
    state.mode = WAVE3_MODE_BY_ID.get(display.waveOperatingMode);
  }

  const mode = display.waveOperatingMode;
  const modeParameters = display.waveModeInfo?.listInfo[mode];
  if (modeParameters !== undefined && mode >= 1) {
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'submode')) {
      state.submode = modeParameters.submode;
    }
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'airflowSpeed')) {
      state.airflowSpeed = modeParameters.airflowSpeed;
    }
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'tempSet')) {
      state.targetTemperatureCelsius = modeParameters.tempSet;
    }
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'humiSet')) {
      state.targetHumidityPercent = modeParameters.humiSet;
    }
    if (has(
      modeParameters,
      Wave3WaveOperatingModeParamItemSchema,
      'tempThermostaticLowerLimit',
    )) {
      state.targetTemperatureLowerCelsius = modeParameters.tempThermostaticLowerLimit;
    }
    if (has(
      modeParameters,
      Wave3WaveOperatingModeParamItemSchema,
      'tempThermostaticUpperLimit',
    )) {
      state.targetTemperatureUpperCelsius = modeParameters.tempThermostaticUpperLimit;
    }
  }

  return state;
}

function normalizeRuntimeTemperatures(
  runtime: MessageShape<typeof Wave3RuntimePropertyUploadSchema>,
): Wave3RuntimeTemperatures {
  const temperatures: Wave3RuntimeTemperatures = {};
  if (has(runtime, Wave3RuntimePropertyUploadSchema, 'tempIndoorReturnAir')) {
    temperatures.indoorReturnAirCelsius = runtime.tempIndoorReturnAir;
  }
  if (has(runtime, Wave3RuntimePropertyUploadSchema, 'tempOutdoorAmbient')) {
    temperatures.outdoorAmbientCelsius = runtime.tempOutdoorAmbient;
  }
  if (has(runtime, Wave3RuntimePropertyUploadSchema, 'tempCondenser')) {
    temperatures.condenserCelsius = runtime.tempCondenser;
  }
  if (has(runtime, Wave3RuntimePropertyUploadSchema, 'tempEvaporator')) {
    temperatures.evaporatorCelsius = runtime.tempEvaporator;
  }
  if (has(runtime, Wave3RuntimePropertyUploadSchema, 'tempCompressorDischarge')) {
    temperatures.compressorDischargeCelsius = runtime.tempCompressorDischarge;
  }
  return temperatures;
}

function normalizeAcknowledgement(
  acknowledgement: MessageShape<typeof Wave3ConfigWriteAckSchema>,
): Wave3Acknowledgement {
  const values: Wave3AcknowledgedValues = {};
  assignIfPresent(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgMainPower', values, 'mainPower');
  assignModeIfPresent(acknowledgement, values);
  assignIfPresent(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgWaveOperatingSubmode', values, 'submode');
  assignIfPresent(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgAirflowSpeed', values, 'airflowSpeed');
  assignIfPresent(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgTempSet', values, 'targetTemperatureCelsius');
  assignIfPresent(
    acknowledgement,
    Wave3ConfigWriteAckSchema,
    'cfgTempThermostaticLowerLimit',
    values,
    'targetTemperatureLowerCelsius',
  );
  assignIfPresent(
    acknowledgement,
    Wave3ConfigWriteAckSchema,
    'cfgTempThermostaticUpperLimit',
    values,
    'targetTemperatureUpperCelsius',
  );
  assignIfPresent(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgSysPause', values, 'systemPaused');

  return {
    actionId: has(acknowledgement, Wave3ConfigWriteAckSchema, 'actionId') ? acknowledgement.actionId : undefined,
    accepted: has(acknowledgement, Wave3ConfigWriteAckSchema, 'configOk') ? acknowledgement.configOk : undefined,
    values,
  };
}

function commandToConfig(command: Wave3Command): Record<string, boolean | number> {
  switch (command.type) {
  case 'power':
    return command.on ? { cfgMainPower: true } : { cfgSysPause: true };
  case 'mode':
    return {
      cfgMainPower: true,
      cfgWaveOperatingMode: WAVE3_MODE_IDS[command.mode],
    };
  case 'targetTemperature':
    validateTemperature(command.celsius);
    return { cfgTempSet: command.celsius };
  case 'automaticTemperatureRange':
    validateTemperature(command.lowerCelsius);
    validateTemperature(command.upperCelsius);
    if (command.lowerCelsius > command.upperCelsius) {
      throw new RangeError('automatic temperature lower bound must not exceed upper bound');
    }
    return {
      cfgTempThermostaticLowerLimit: command.lowerCelsius,
      cfgTempThermostaticUpperLimit: command.upperCelsius,
    };
  case 'airflowSpeed':
    return { cfgAirflowSpeed: command.speed };
  case 'submode':
    return { cfgWaveOperatingSubmode: command.submode };
  }
}

function assignIfPresent<
  Schema extends DescMessage,
  Output extends object,
  MessageKey extends string,
  OutputKey extends keyof Output,
>(
  message: MessageShape<Schema>,
  schema: Schema,
  messageKey: MessageKey,
  output: Output,
  outputKey: OutputKey,
): void {
  const field = schema.field[messageKey];
  if (field !== undefined && isFieldSet(message, field)) {
    output[outputKey] = message[messageKey as keyof typeof message] as unknown as Output[OutputKey];
  }
}

function assignModeIfPresent(
  acknowledgement: MessageShape<typeof Wave3ConfigWriteAckSchema>,
  values: Wave3AcknowledgedValues,
): void {
  if (!has(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgWaveOperatingMode')) {
    return;
  }
  const mode = WAVE3_MODE_BY_ID.get(acknowledgement.cfgWaveOperatingMode);
  if (mode !== undefined) {
    values.mode = mode;
  }
}

function has<Schema extends DescMessage>(
  message: MessageShape<Schema>,
  schema: Schema,
  key: string,
): boolean {
  const field = schema.field[key];
  return field !== undefined && isFieldSet(message, field);
}

function withPayloadUnknownCount(
  diagnostic: Wave3Diagnostic,
  message: { $unknown?: unknown[] },
): Wave3Diagnostic {
  return {
    ...diagnostic,
    unknownFieldCount: (diagnostic.unknownFieldCount ?? 0) + (message.$unknown?.length ?? 0),
  };
}

function malformed(payloadLength: number, reason: string): DecodedWave3Message {
  return {
    kind: 'malformed',
    diagnostic: {
      payloadLength,
      reason,
    },
  };
}

function boundedErrorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'protobuf decode failed';
  }
  return error.name === 'RangeError' ? 'truncated protobuf message' : 'invalid protobuf message';
}

function validateDeviceSerial(deviceSerial: string): void {
  if (deviceSerial.trim().length === 0) {
    throw new TypeError('device serial must not be empty');
  }
}

function validateSequence(sequence: number): void {
  if (!Number.isInteger(sequence) || sequence < 10 || sequence > 999) {
    throw new RangeError('sequence must be an integer from 10 through 999');
  }
}

function validateTemperature(celsius: number): void {
  if (!Number.isFinite(celsius) || celsius < 16 || celsius > 30) {
    throw new RangeError('temperature must be from 16 through 30 degrees Celsius');
  }
}
