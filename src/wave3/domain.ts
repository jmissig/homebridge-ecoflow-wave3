export const WAVE3_MODE_IDS = {
  off: 0,
  cool: 1,
  heat: 2,
  fan: 3,
  dry: 4,
  auto: 5,
} as const;

export type Wave3Mode = keyof typeof WAVE3_MODE_IDS;
export type Wave3ControllableMode = Exclude<Wave3Mode, 'off'>;
export type Wave3AirflowSpeed = 20 | 40 | 60 | 80 | 100;
export type Wave3Submode = 0 | 2 | 3 | 4;

export interface Wave3State {
  powered?: boolean;
  sleeping?: boolean;
  mode?: Wave3Mode;
  ambientTemperatureCelsius?: number;
  ambientHumidityPercent?: number;
  outletTemperatureCelsius?: number;
  targetTemperatureCelsius?: number;
  targetTemperatureLowerCelsius?: number;
  targetTemperatureUpperCelsius?: number;
  airflowSpeed?: number;
  submode?: number;
}

export interface Wave3ModeParameters {
  submode?: number;
  airflowSpeed?: number;
  targetTemperatureCelsius?: number;
  targetTemperatureLowerCelsius?: number;
  targetTemperatureUpperCelsius?: number;
}

export type Wave3ModeProfiles = Readonly<Partial<Record<
  Wave3ControllableMode,
  Readonly<Wave3ModeParameters>
>>>;

export interface Wave3DisplayUpdate {
  sleepState?: number;
  operatingModeId?: number;
  ambientTemperatureCelsius?: number;
  ambientHumidityPercent?: number;
  outletTemperatureCelsius?: number;
  modeParameters: Readonly<Record<number, Wave3ModeParameters>>;
}

export interface Wave3DisplayState {
  sleepState?: number;
  operatingModeId?: number;
  modeParameters: Readonly<Record<number, Wave3ModeParameters>>;
  state: Wave3State;
}

export interface Wave3RuntimeTemperatures {
  indoorReturnAirCelsius?: number;
  outdoorAmbientCelsius?: number;
  condenserCelsius?: number;
  evaporatorCelsius?: number;
  compressorDischargeCelsius?: number;
}

export interface Wave3FirmwareVersions {
  pd?: string;
  iot?: string;
  mppt?: string;
  llc?: string;
  bms?: string;
}

export interface Wave3ModeCommand {
  type: 'mode';
  mode: Wave3ControllableMode;
  targetTemperatureCelsius?: number;
  targetTemperatureLowerCelsius?: number;
  targetTemperatureUpperCelsius?: number;
}

export type Wave3Command =
  | { type: 'power'; on: boolean }
  | Wave3ModeCommand
  | { type: 'targetTemperature'; celsius: number }
  | { type: 'automaticTemperatureRange'; lowerCelsius: number; upperCelsius: number }
  | { type: 'airflowSpeed'; speed: Wave3AirflowSpeed }
  | { type: 'submode'; submode: Wave3Submode };

export type Wave3AcknowledgedValues = Partial<{
  mainPower: boolean;
  mode: Wave3Mode;
  submode: number;
  airflowSpeed: number;
  targetTemperatureCelsius: number;
  targetTemperatureLowerCelsius: number;
  targetTemperatureUpperCelsius: number;
  systemPaused: boolean;
}>;

export interface Wave3Acknowledgement {
  actionId?: number;
  reportedConfigOk?: boolean;
  values: Wave3AcknowledgedValues;
}

export type Wave3Availability =
  | 'accountError'
  | 'offline'
  | 'reconnecting'
  | 'online'
  | 'stale'
  | 'stopped';

export interface Wave3ControllerSnapshot {
  availability: Wave3Availability;
  state: Readonly<Wave3State>;
  modeProfiles: Wave3ModeProfiles;
  runtimeTemperatures: Readonly<Wave3RuntimeTemperatures>;
  firmwareVersions?: Readonly<Wave3FirmwareVersions>;
  updatedAt?: number;
}

export type Wave3CommandFailure =
  | 'publicationFailed'
  | 'acknowledgementRejected'
  | 'timeout'
  | 'disconnected'
  | 'stopped';

export type Wave3CommandResult =
  | {
    status: 'confirmed';
    sequence: number;
  }
  | {
    status: 'failed';
    sequence: number;
    reason: Wave3CommandFailure;
  };
