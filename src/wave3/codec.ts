import {
  create,
  fromBinary,
  isFieldSet,
  toBinary,
  type DescMessage,
  type MessageShape,
  type UnknownField,
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
  unknownFields?: ReadonlyArray<{
    scope: string;
    number: number;
    wireType: string;
    dataLength: number;
  }>;
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

export type DecodedWave3QuotaReply =
  | {
    kind: 'quota';
    deviceOnline: boolean;
    update?: Wave3DisplayUpdate;
  }
  | {
    kind: 'malformed';
    reason: string;
  };

const MAX_QUOTA_REPLY_BYTES = 64 * 1024;

export function decodeWave3Message(bytes: Uint8Array): DecodedWave3Message {
  try {
    const message = fromBinary(Wave3SetMessageSchema, bytes);
    const header = message.header;

    if (header === undefined) {
      return malformed(bytes.length, 'missing envelope header');
    }
    const encodedPayload = header.pdata ?? new Uint8Array();

    const envelopeUnknownFields = collectUnknownFieldDiagnostics([
      ['envelope', message],
      ['header', header],
    ]);
    const diagnostic: Wave3Diagnostic = {
      commandFunction: header.cmdFunc,
      commandId: header.cmdId,
      sequence: header.seq,
      payloadLength: encodedPayload.length,
      unknownFieldCount: envelopeUnknownFields.count,
      ...(envelopeUnknownFields.fields.length === 0
        ? {}
        : { unknownFields: envelopeUnknownFields.fields }),
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
          collectDisplayUnknownFieldDiagnostics(display),
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
        diagnostic: withPayloadDiagnostics(
          diagnostic,
          collectUnknownFieldDiagnostics([['payload', runtime]]),
        ),
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
          collectUnknownFieldDiagnostics([['payload', acknowledgement]]),
          normalized.unsupportedValues,
        ),
      };
    }

    return { kind: 'unknown', diagnostic };
  } catch (error) {
    return malformed(bytes.length, boundedErrorReason(error));
  }
}

export function decodeWave3QuotaReply(bytes: Uint8Array): DecodedWave3QuotaReply {
  if (bytes.length > MAX_QUOTA_REPLY_BYTES) {
    return { kind: 'malformed', reason: 'quota reply exceeds size limit' };
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    const message = requireRecord(parsed, 'quota reply');
    if (message.operateType !== 'latestQuotas') {
      return { kind: 'malformed', reason: 'unexpected quota reply operation' };
    }
    const data = requireRecord(message.data, 'quota reply data');
    const deviceOnline = parseOnlineValue(data.online);
    if (!deviceOnline) {
      return { kind: 'quota', deviceOnline: false };
    }

    const quotaMap = requireRecord(data.quotaMap, 'quota map');
    const update: Wave3DisplayUpdate = { modeParameters: {} };
    assignQuotaNumber(quotaMap, 'dev_sleep_state', update, 'sleepState');
    assignQuotaNumber(quotaMap, 'wave_operating_mode', update, 'operatingModeId');
    assignQuotaNumber(
      quotaMap,
      'temp_ambient',
      update,
      'ambientTemperatureCelsius',
    );
    assignQuotaNumber(
      quotaMap,
      'humi_ambient',
      update,
      'ambientHumidityPercent',
    );
    if (update.ambientTemperatureCelsius !== undefined
      && !isSupportedAmbientTemperature(update.ambientTemperatureCelsius)) {
      throw new TypeError('quota ambient temperature is unsupported');
    }
    if (update.ambientHumidityPercent !== undefined
      && (update.ambientHumidityPercent < 0 || update.ambientHumidityPercent > 100)) {
      throw new TypeError('quota ambient humidity is unsupported');
    }
    if (update.sleepState !== undefined && update.sleepState !== 0 && update.sleepState !== 1) {
      throw new TypeError('quota sleep state is unsupported');
    }
    if (update.operatingModeId !== undefined
      && (!Number.isInteger(update.operatingModeId)
        || !WAVE3_MODE_BY_ID.has(update.operatingModeId))) {
      throw new TypeError('quota operating mode is unsupported');
    }
    if (update.operatingModeId === undefined) {
      throw new TypeError('quota reply lacks operating mode');
    }

    const parameters: Wave3ModeParameters = {};
    assignQuotaNumber(
      quotaMap,
      'current_temp_set',
      parameters,
      'targetTemperatureCelsius',
    );
    assignQuotaNumber(
      quotaMap,
      'current_temp_lower',
      parameters,
      'targetTemperatureLowerCelsius',
    );
    assignQuotaNumber(
      quotaMap,
      'current_temp_upper',
      parameters,
      'targetTemperatureUpperCelsius',
    );
    assignQuotaNumber(quotaMap, 'current_airflow_speed', parameters, 'airflowSpeed');
    assignQuotaNumber(quotaMap, 'current_submode', parameters, 'submode');
    for (const temperature of [
      parameters.targetTemperatureCelsius,
      parameters.targetTemperatureLowerCelsius,
      parameters.targetTemperatureUpperCelsius,
    ]) {
      if (temperature !== undefined
        && (!Number.isInteger(temperature) || temperature < 16 || temperature > 30)) {
        throw new TypeError('quota target temperature is unsupported');
      }
    }
    if (parameters.airflowSpeed !== undefined
      && ![20, 40, 60, 80, 100].includes(parameters.airflowSpeed)) {
      throw new TypeError('quota airflow speed is unsupported');
    }
    if (parameters.submode !== undefined
      && ![0, 2, 3, 4].includes(parameters.submode)) {
      throw new TypeError('quota submode is unsupported');
    }
    if (parameters.targetTemperatureLowerCelsius !== undefined
      && parameters.targetTemperatureUpperCelsius !== undefined
      && parameters.targetTemperatureLowerCelsius
        > parameters.targetTemperatureUpperCelsius) {
      throw new TypeError('quota automatic temperature range is invalid');
    }
    if (Object.values(parameters).some(value => value !== undefined)) {
      (update.modeParameters as Record<number, Wave3ModeParameters>)[
        update.operatingModeId
      ] = parameters;
    }

    return { kind: 'quota', deviceOnline: true, update };
  } catch (error) {
    return { kind: 'malformed', reason: boundedQuotaErrorReason(error) };
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

export function hasWave3DisplayEvidence(update: Wave3DisplayUpdate): boolean {
  return update.sleepState !== undefined
    || update.operatingModeId !== undefined
    || update.ambientTemperatureCelsius !== undefined
    || update.ambientHumidityPercent !== undefined
    || Object.keys(update.modeParameters).length > 0;
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
    if (sleepState === 0 || sleepState === 1) {
      update.sleepState = sleepState;
    } else {
      addUnsupportedValue(unsupportedValues, 'dev_sleep_state', sleepState);
    }
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'tempAmbient')) {
    const temperature = display.tempAmbient!;
    if (isSupportedAmbientTemperature(temperature)) {
      update.ambientTemperatureCelsius = temperature;
    } else {
      addUnsupportedValue(unsupportedValues, 'temp_ambient', temperature);
    }
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'humiAmbient')) {
    const humidity = display.humiAmbient!;
    if (Number.isFinite(humidity) && humidity >= 0 && humidity <= 100) {
      update.ambientHumidityPercent = humidity;
    } else {
      addUnsupportedValue(unsupportedValues, 'humi_ambient', humidity);
    }
  }
  if (has(display, Wave3DisplayPropertyUploadSchema, 'waveOperatingMode')) {
    const operatingModeId = display.waveOperatingMode!;
    if (WAVE3_MODE_BY_ID.has(operatingModeId)) {
      update.operatingModeId = operatingModeId;
    } else {
      addUnsupportedValue(unsupportedValues, 'wave_operating_mode', operatingModeId);
    }
  }

  display.waveModeInfo?.listInfo.forEach((modeParameters, modeId) => {
    if (!WAVE3_MODE_BY_ID.has(modeId)) {
      if (modeParameters.$unknown?.length !== undefined
        || modeParameters.submode !== undefined
        || modeParameters.airflowSpeed !== undefined
        || modeParameters.tempSet !== undefined
        || modeParameters.tempThermostaticLowerLimit !== undefined
        || modeParameters.tempThermostaticUpperLimit !== undefined) {
        addUnsupportedValue(unsupportedValues, 'wave_mode_info.mode_id', modeId);
      }
      return;
    }
    const parameters: Wave3ModeParameters = {};
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'submode')) {
      const submode = modeParameters.submode!;
      if ([0, 2, 3, 4].includes(submode)) {
        parameters.submode = submode;
      } else {
        addUnsupportedValue(
          unsupportedValues,
          `wave_mode_info[${modeId}].submode`,
          submode,
        );
      }
    }
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'airflowSpeed')) {
      const airflowSpeed = modeParameters.airflowSpeed!;
      if ([20, 40, 60, 80, 100].includes(airflowSpeed)) {
        parameters.airflowSpeed = airflowSpeed;
      } else {
        addUnsupportedValue(
          unsupportedValues,
          `wave_mode_info[${modeId}].airflow_speed`,
          airflowSpeed,
        );
      }
    }
    if (has(modeParameters, Wave3WaveOperatingModeParamItemSchema, 'tempSet')) {
      const target = modeParameters.tempSet!;
      if (isSupportedTargetTemperature(target)) {
        parameters.targetTemperatureCelsius = target;
      } else {
        addUnsupportedValue(
          unsupportedValues,
          `wave_mode_info[${modeId}].temp_set`,
          target,
        );
      }
    }
    if (has(
      modeParameters,
      Wave3WaveOperatingModeParamItemSchema,
      'tempThermostaticLowerLimit',
    )) {
      const lower = modeParameters.tempThermostaticLowerLimit!;
      if (isSupportedTargetTemperature(lower)) {
        parameters.targetTemperatureLowerCelsius = lower;
      } else {
        addUnsupportedValue(
          unsupportedValues,
          `wave_mode_info[${modeId}].temp_thermostatic_lower_limit`,
          lower,
        );
      }
    }
    if (has(
      modeParameters,
      Wave3WaveOperatingModeParamItemSchema,
      'tempThermostaticUpperLimit',
    )) {
      const upper = modeParameters.tempThermostaticUpperLimit!;
      if (isSupportedTargetTemperature(upper)) {
        parameters.targetTemperatureUpperCelsius = upper;
      } else {
        addUnsupportedValue(
          unsupportedValues,
          `wave_mode_info[${modeId}].temp_thermostatic_upper_limit`,
          upper,
        );
      }
    }
    if (Object.keys(parameters).length > 0) {
      (update.modeParameters as Record<number, Wave3ModeParameters>)[modeId] = parameters;
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

const MAX_DIAGNOSTIC_UNKNOWN_FIELDS = 16;
const WIRE_TYPE_NAMES = [
  'varint',
  'fixed64',
  'lengthDelimited',
  'startGroup',
  'endGroup',
  'fixed32',
] as const;

function withPayloadDiagnostics(
  diagnostic: Wave3Diagnostic,
  payloadUnknownFields: UnknownFieldDiagnostics,
  unsupportedValues?: Wave3Diagnostic['unsupportedValues'],
): Wave3Diagnostic {
  const unknownFields = [
    ...(diagnostic.unknownFields ?? []),
    ...payloadUnknownFields.fields,
  ].slice(0, MAX_DIAGNOSTIC_UNKNOWN_FIELDS);
  return {
    ...diagnostic,
    unknownFieldCount: (diagnostic.unknownFieldCount ?? 0) + payloadUnknownFields.count,
    ...(unknownFields.length === 0 ? {} : { unknownFields }),
    ...(unsupportedValues === undefined ? {} : { unsupportedValues }),
  };
}

interface UnknownFieldDiagnostics {
  count: number;
  fields: NonNullable<Wave3Diagnostic['unknownFields']>;
}

function collectUnknownFieldDiagnostics(
  messages: ReadonlyArray<readonly [string, { $unknown?: UnknownField[] } | undefined]>,
): UnknownFieldDiagnostics {
  let count = 0;
  const fields: Array<NonNullable<Wave3Diagnostic['unknownFields']>[number]> = [];
  for (const [scope, message] of messages) {
    for (const field of message?.$unknown ?? []) {
      count += 1;
      if (fields.length < MAX_DIAGNOSTIC_UNKNOWN_FIELDS) {
        fields.push({
          scope,
          number: field.no,
          wireType: WIRE_TYPE_NAMES[field.wireType] ?? `unknown(${field.wireType})`,
          dataLength: field.data.length,
        });
      }
    }
  }
  return { count, fields };
}

function collectDisplayUnknownFieldDiagnostics(
  display: MessageShape<typeof Wave3DisplayPropertyUploadSchema>,
): UnknownFieldDiagnostics {
  return collectUnknownFieldDiagnostics([
    ['payload', display],
    ['waveModeInfo', display.waveModeInfo],
    ...(display.waveModeInfo?.listInfo ?? []).map(
      (mode, index) => [`waveModeInfo[${index}]`, mode] as const,
    ),
  ]);
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

function isSupportedAmbientTemperature(value: number): boolean {
  return Number.isFinite(value) && value >= -270 && value <= 100;
}

function isSupportedTargetTemperature(value: number): boolean {
  return Number.isInteger(value) && value >= 16 && value <= 30;
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

function boundedQuotaErrorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'invalid quota reply';
  }
  if (error instanceof TypeError && error.message.length <= 80) {
    return error.message;
  }
  return 'invalid quota reply';
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseOnlineValue(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') {
    return true;
  }
  if (value === false || value === 0 || value === '0') {
    return false;
  }
  throw new TypeError('quota online flag is invalid');
}

function assignQuotaNumber<
  Output extends object,
  Key extends keyof Output,
>(
  record: Record<string, unknown>,
  sourceKey: string,
  output: Output,
  outputKey: Key,
): void {
  const value = record[sourceKey];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`quota field ${sourceKey} must be a finite number`);
  }
  output[outputKey] = value as Output[Key];
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
  if (!Number.isInteger(celsius) || celsius < 16 || celsius > 30) {
    throw new RangeError('temperature must be a whole degree from 16 through 30 Celsius');
  }
}
