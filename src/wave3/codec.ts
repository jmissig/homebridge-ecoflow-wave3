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
  type Wave3DisplayState,
  type Wave3DisplayUpdate,
  type Wave3Mode,
  type Wave3ModeParameters,
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
  unsupportedValues?: ReadonlyArray<{
    field: string;
    value: number;
  }>;
  reason?: string;
}

export type DecodedWave3Message =
  | {
    kind: 'display';
    sequence: number;
    update: Wave3DisplayUpdate;
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
    const encodedPayload = header.pdata ?? new Uint8Array();

    const diagnostic: Wave3Diagnostic = {
      commandFunction: header.cmdFunc,
      commandId: header.cmdId,
      sequence: header.seq,
      payloadLength: encodedPayload.length,
      unknownFieldCount: countUnknownFields(message, header),
    };

    if (encodedPayload.length === 0) {
      return { kind: 'malformed', diagnostic: { ...diagnostic, reason: 'missing payload' } };
    }

    if (isFieldSet(header, Wave3SetHeaderSchema.field.dataLen)
      && header.dataLen !== encodedPayload.length) {
      return { kind: 'malformed', diagnostic: { ...diagnostic, reason: 'payload length mismatch' } };
    }

    const payload = transformWave3Payload(
      encodedPayload,
      header.encType ?? 0,
      header.src ?? 0,
      header.seq ?? 0,
    );

    if (header.cmdFunc !== WAVE3_COMMAND_FUNCTION) {
      return { kind: 'unknown', diagnostic };
    }

    if (DISPLAY_COMMAND_IDS.has(header.cmdId ?? 0)) {
      const display = fromBinary(Wave3DisplayPropertyUploadSchema, payload);
      const normalized = normalizeDisplayUpdate(display);
      return {
        kind: 'display',
        sequence: header.seq ?? 0,
        update: normalized.update,
        diagnostic: withPayloadDiagnostics(
          diagnostic,
          countDisplayUnknownFields(display),
          normalized.unsupportedValues,
        ),
      };
    }

    if (header.cmdId === RUNTIME_COMMAND_ID) {
      const runtime = fromBinary(Wave3RuntimePropertyUploadSchema, payload);
      return {
        kind: 'runtime',
        sequence: header.seq ?? 0,
        temperatures: normalizeRuntimeTemperatures(runtime),
        diagnostic: withPayloadDiagnostics(diagnostic, countUnknownFields(runtime)),
      };
    }

    if (header.cmdId === ACK_COMMAND_ID) {
      const acknowledgement = fromBinary(Wave3ConfigWriteAckSchema, payload);
      const normalized = normalizeAcknowledgement(acknowledgement);
      return {
        kind: 'acknowledgement',
        sequence: header.seq ?? 0,
        acknowledgement: normalized.acknowledgement,
        diagnostic: withPayloadDiagnostics(
          diagnostic,
          countUnknownFields(acknowledgement),
          normalized.unsupportedValues,
        ),
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

export function mergeWave3DisplayUpdate(
  previous: Wave3DisplayState | undefined,
  update: Wave3DisplayUpdate,
): Wave3DisplayState {
  const sleepState = update.sleepState ?? previous?.sleepState;
  const operatingModeId = update.operatingModeId ?? previous?.operatingModeId;
  const modeParameters: Record<number, Wave3ModeParameters> = {
    ...previous?.modeParameters,
  };

  for (const [modeId, parameters] of Object.entries(update.modeParameters)) {
    const numericModeId = Number(modeId);
    modeParameters[numericModeId] = {
      ...modeParameters[numericModeId],
      ...parameters,
    };
  }

  const state: Wave3State = {};
  const ambientTemperature = update.ambientTemperatureCelsius
    ?? previous?.state.ambientTemperatureCelsius;
  const ambientHumidity = update.ambientHumidityPercent
    ?? previous?.state.ambientHumidityPercent;
  if (ambientTemperature !== undefined) {
    state.ambientTemperatureCelsius = ambientTemperature;
  }
  if (ambientHumidity !== undefined) {
    state.ambientHumidityPercent = ambientHumidity;
  }

  if (sleepState === 0 || sleepState === 1) {
    state.sleeping = sleepState === 1;
  }

  const reportedMode = operatingModeId === undefined
    ? undefined
    : WAVE3_MODE_BY_ID.get(operatingModeId);
  if (sleepState === 1) {
    state.mode = 'off';
    state.powered = false;
  } else if (reportedMode !== undefined) {
    state.mode = reportedMode;
    state.powered = reportedMode !== 'off';
  } else if (operatingModeId === 0) {
    state.mode = 'off';
    state.powered = false;
  }

  if (operatingModeId !== undefined) {
    Object.assign(state, modeParameters[operatingModeId]);
  }

  return {
    sleepState,
    operatingModeId,
    modeParameters,
    state,
  };
}

function normalizeDisplayUpdate(
  display: MessageShape<typeof Wave3DisplayPropertyUploadSchema>,
): {
  update: Wave3DisplayUpdate;
  unsupportedValues: Wave3Diagnostic['unsupportedValues'];
} {
  const update: Wave3DisplayUpdate = { modeParameters: {} };
  const unsupportedValues: Array<{ field: string; value: number }> = [];

  if (has(display, Wave3DisplayPropertyUploadSchema, 'devSleepState')) {
    const sleepState = display.devSleepState!;
    update.sleepState = sleepState;
    if (sleepState !== 0 && sleepState !== 1) {
      addUnsupportedValue(unsupportedValues, 'dev_sleep_state', sleepState);
    }
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'tempAmbient')) {
    update.ambientTemperatureCelsius = display.tempAmbient;
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'humiAmbient')) {
    update.ambientHumidityPercent = display.humiAmbient;
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'waveOperatingMode')) {
    const operatingModeId = display.waveOperatingMode!;
    update.operatingModeId = operatingModeId;
    if (!WAVE3_MODE_BY_ID.has(operatingModeId)) {
      addUnsupportedValue(unsupportedValues, 'wave_operating_mode', operatingModeId);
    }
  }

  display.waveModeInfo?.listInfo.forEach((modeParameters, modeId) => {
    const parameters: Wave3ModeParameters = {};
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'submode')) {
      const submode = modeParameters.submode!;
      parameters.submode = submode;
      if (![0, 2, 3, 4].includes(submode)) {
        addUnsupportedValue(
          unsupportedValues,
          `wave_mode_info[${modeId}].submode`,
          submode,
        );
      }
    }
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'airflowSpeed')) {
      parameters.airflowSpeed = modeParameters.airflowSpeed;
    }
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'tempSet')) {
      parameters.targetTemperatureCelsius = modeParameters.tempSet;
    }
    if (has(
      modeParameters,
      Wave3WaveOperatingModeParamItemSchema,
      'tempThermostaticLowerLimit',
    )) {
      parameters.targetTemperatureLowerCelsius = modeParameters.tempThermostaticLowerLimit;
    }
    if (has(
      modeParameters,
      Wave3WaveOperatingModeParamItemSchema,
      'tempThermostaticUpperLimit',
    )) {
      parameters.targetTemperatureUpperCelsius = modeParameters.tempThermostaticUpperLimit;
    }
    if (Object.keys(parameters).length > 0) {
      (update.modeParameters as Record<number, Wave3ModeParameters>)[modeId] = parameters;
      if (!WAVE3_MODE_BY_ID.has(modeId)) {
        addUnsupportedValue(unsupportedValues, 'wave_mode_info.mode_id', modeId);
      }
    }
  });

  return {
    update,
    unsupportedValues: unsupportedValues.length === 0 ? undefined : unsupportedValues,
  };
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
): {
  acknowledgement: Wave3Acknowledgement;
  unsupportedValues: Wave3Diagnostic['unsupportedValues'];
} {
  const values: Wave3AcknowledgedValues = {};
  const unsupportedValues: Array<{ field: string; value: number }> = [];
  assignIfPresent(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgMainPower', values, 'mainPower');
  assignModeIfPresent(acknowledgement, values, unsupportedValues);
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
    acknowledgement: {
      actionId: has(acknowledgement, Wave3ConfigWriteAckSchema, 'actionId') ? acknowledgement.actionId : undefined,
      reportedConfigOk: has(acknowledgement, Wave3ConfigWriteAckSchema, 'configOk') ? acknowledgement.configOk : undefined,
      values,
    },
    unsupportedValues: unsupportedValues.length === 0 ? undefined : unsupportedValues,
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
  unsupportedValues: Array<{ field: string; value: number }>,
): void {
  if (!has(acknowledgement, Wave3ConfigWriteAckSchema, 'cfgWaveOperatingMode')) {
    return;
  }
  const operatingModeId = acknowledgement.cfgWaveOperatingMode!;
  const mode = WAVE3_MODE_BY_ID.get(operatingModeId);
  if (mode !== undefined) {
    values.mode = mode;
  } else {
    addUnsupportedValue(
      unsupportedValues,
      'cfg_wave_operating_mode',
      operatingModeId,
    );
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

function withPayloadDiagnostics(
  diagnostic: Wave3Diagnostic,
  payloadUnknownFieldCount: number,
  unsupportedValues?: Wave3Diagnostic['unsupportedValues'],
): Wave3Diagnostic {
  return {
    ...diagnostic,
    unknownFieldCount: (diagnostic.unknownFieldCount ?? 0) + payloadUnknownFieldCount,
    ...(unsupportedValues === undefined ? {} : { unsupportedValues }),
  };
}

function countUnknownFields(...messages: Array<{ $unknown?: unknown[] } | undefined>): number {
  return messages.reduce((count, message) => count + (message?.$unknown?.length ?? 0), 0);
}

function countDisplayUnknownFields(
  display: MessageShape<typeof Wave3DisplayPropertyUploadSchema>,
): number {
  return countUnknownFields(
    display,
    display.waveModeInfo,
    ...(display.waveModeInfo?.listInfo ?? []),
  );
}

function addUnsupportedValue(
  values: Array<{ field: string; value: number }>,
  field: string,
  value: number,
): void {
  if (values.length < 8) {
    values.push({ field, value });
  }
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
