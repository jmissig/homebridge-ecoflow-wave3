export const MATTER_ACCESSORY_SCHEMA_VERSION = 5 as const;

export type Wave3MatterAccessoryPresentation =
  | 'roomAirConditioner'
  | 'plainThermostatSpike';

export interface Wave3MatterAccessoryContext {
  schemaVersion: typeof MATTER_ACCESSORY_SCHEMA_VERSION;
  serialNumber: string;
  presentation?: Wave3MatterAccessoryPresentation;
  lastSystemMode?: number;
  lastConfirmedAt?: number;
  firmwareRevision?: string;
}
