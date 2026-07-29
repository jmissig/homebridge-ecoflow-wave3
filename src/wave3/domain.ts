export const WAVE3_MODE_IDS = {
  cool: 1,
  heat: 2,
  fan: 3,
  dry: 4,
  auto: 5,
} as const;

export type Wave3Mode = keyof typeof WAVE3_MODE_IDS;
export type Wave3ControllableMode = Exclude<Wave3Mode, 'dry'>;
export type Wave3AirflowSpeed = 20 | 40 | 60 | 80 | 100;
export type Wave3Submode = 0 | 2 | 3 | 4;

export interface Wave3State {
  powered?: boolean;
  sleeping?: boolean;
  mode?: Wave3Mode;
  ambientTemperatureCelsius?: number;
  ambientHumidityPercent?: number;
  targetTemperatureCelsius?: number;
  targetTemperatureLowerCelsius?: number;
  targetTemperatureUpperCelsius?: number;
  targetHumidityPercent?: number;
  airflowSpeed?: number;
  submode?: number;
}

export interface Wave3RuntimeTemperatures {
  indoorReturnAirCelsius?: number;
  outdoorAmbientCelsius?: number;
  condenserCelsius?: number;
  evaporatorCelsius?: number;
  compressorDischargeCelsius?: number;
}

export type Wave3Command =
  | { type: 'power'; on: boolean }
  | { type: 'mode'; mode: Wave3ControllableMode }
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
  accepted?: boolean;
  values: Wave3AcknowledgedValues;
}
