export const MATTER_ACCESSORY_SCHEMA_VERSION = 3 as const;

export interface Wave3MatterAccessoryContext {
  schemaVersion: typeof MATTER_ACCESSORY_SCHEMA_VERSION;
  serialNumber: string;
  lastSystemMode?: number;
  lastConfirmedAt?: number;
  firmwareRevision?: string;
}
