import type { Wave3DeviceConfig } from '../ecoflow/config.js';

export const MATTER_ACCESSORY_SCHEMA_VERSION = 2 as const;

export interface Wave3MatterAccessoryContext {
  schemaVersion: typeof MATTER_ACCESSORY_SCHEMA_VERSION;
  serialNumber: string;
  currentTemperatureSource: Wave3DeviceConfig['currentTemperatureSource'];
  lastSystemMode?: number;
  lastConfirmedAt?: number;
  firmwareRevision?: string;
}
