import type { Wave3DeviceConfig } from '../ecoflow/config.js';

export interface Wave3MatterAccessoryContext {
  schemaVersion: 1;
  serialNumber: string;
  currentTemperatureSource: Wave3DeviceConfig['currentTemperatureSource'];
  lastSystemMode?: number;
  lastConfirmedAt?: number;
  firmwareRevision?: string;
}
