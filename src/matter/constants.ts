export const DEFAULT_TEMPERATURE_CENTIDEGREES = 2_000;

export const MATTER_SYSTEM_MODE = {
  auto: 0x01,
  cool: 0x03,
  heat: 0x04,
  fan: 0x07,
  dry: 0x08,
  sleep: 0x09,
} as const;

export const MATTER_FAN_MODE = {
  off: 0x00,
  low: 0x01,
  medium: 0x02,
  high: 0x03,
} as const;

export const MATTER_THERMOSTAT_UI_CLUSTER = 'thermostatUserInterfaceConfiguration';

export const MATTER_TEMPERATURE_DISPLAY_MODE = {
  celsius: 0x00,
  fahrenheit: 0x01,
} as const;
