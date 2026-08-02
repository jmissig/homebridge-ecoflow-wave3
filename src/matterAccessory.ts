import {
  devices,
  type MatterAccessory,
  type MatterAPI,
} from 'homebridge';

import type { CurrentTemperatureSource, Wave3DeviceConfig } from './ecoflow/config.js';
import type { Wave3AccessoryController } from './platformAccessory.js';
import type { Wave3MatterAccessoryContext } from './platform.js';
import type { Wave3ControllerSnapshot, Wave3Mode } from './wave3/domain.js';

const DEFAULT_TEMPERATURE_CENTIDEGREES = 2_000;

export const MATTER_SYSTEM_MODE = {
  auto: 0x01,
  cool: 0x03,
  heat: 0x04,
  fan: 0x07,
  dry: 0x08,
  sleep: 0x09,
} as const;

const MATTER_RUNNING_MODE = {
  off: 0x00,
  cool: 0x03,
  heat: 0x04,
} as const;

const MATTER_FAN_MODE = {
  off: 0x00,
  low: 0x01,
  medium: 0x02,
  high: 0x03,
} as const;

const desiredMatterState = new Map<string, unknown>();
const Wave3OnOffBase = devices.RoomAirConditionerRequirements.OnOffServer;
const Wave3ThermostatBase = devices.RoomAirConditionerRequirements.ThermostatServer.with(
  'Heating',
  'Cooling',
  'AutoMode',
);
const Wave3NoTemperatureThermostatBase = devices.RoomAirConditionerRequirements.ThermostatServer.with(
  'Heating',
  'Cooling',
  'AutoMode',
  'LocalTemperatureNotExposed',
);
const MultiSpeedFanControlServer = devices.RoomAirConditionerRequirements.FanControlServer.with(
  'MultiSpeed',
);

class Wave3OnOffServer extends Wave3OnOffBase {
  override on(): never {
    throw controlsUnavailable();
  }

  override off(): never {
    throw controlsUnavailable();
  }

  override toggle(): never {
    throw controlsUnavailable();
  }
}

class Wave3FanControlServer extends MultiSpeedFanControlServer {
  override initialize(): void {
    super.initialize();
    this.reactTo(this.events.fanMode$Changing, this.validateFanMode);
    this.reactTo(this.events.percentSetting$Changing, this.validatePercentSetting);
    this.reactTo(this.events.speedSetting$Changing, this.validateSpeedSetting);
  }

  private validateFanMode(value: number): void {
    requireDesiredValue(this.endpoint.id, 'fanControl', 'fanMode', value);
  }

  private validatePercentSetting(value: number | null): void {
    requireDesiredValue(this.endpoint.id, 'fanControl', 'percentSetting', value);
  }

  private validateSpeedSetting(value: number | null): void {
    requireDesiredValue(this.endpoint.id, 'fanControl', 'speedSetting', value);
  }
}

class Wave3ThermostatServer extends Wave3ThermostatBase {
  override initialize(): void {
    super.initialize();
    this.reactTo(
      this.events.systemMode$Changing,
      value => requireDesiredValue(this.endpoint.id, 'thermostat', 'systemMode', value),
    );
    this.reactTo(
      this.events.occupiedHeatingSetpoint$Changing,
      value => requireDesiredValue(
        this.endpoint.id,
        'thermostat',
        'occupiedHeatingSetpoint',
        value,
      ),
    );
    this.reactTo(
      this.events.occupiedCoolingSetpoint$Changing,
      value => requireDesiredValue(
        this.endpoint.id,
        'thermostat',
        'occupiedCoolingSetpoint',
        value,
      ),
    );
  }

  override setpointRaiseLower(): never {
    throw controlsUnavailable();
  }
}

class Wave3NoTemperatureThermostatServer extends Wave3NoTemperatureThermostatBase {
  override initialize(): void {
    super.initialize();
    this.reactTo(
      this.events.systemMode$Changing,
      value => requireDesiredValue(this.endpoint.id, 'thermostat', 'systemMode', value),
    );
    this.reactTo(
      this.events.occupiedHeatingSetpoint$Changing,
      value => requireDesiredValue(
        this.endpoint.id,
        'thermostat',
        'occupiedHeatingSetpoint',
        value,
      ),
    );
    this.reactTo(
      this.events.occupiedCoolingSetpoint$Changing,
      value => requireDesiredValue(
        this.endpoint.id,
        'thermostat',
        'occupiedCoolingSetpoint',
        value,
      ),
    );
  }

  override setpointRaiseLower(): never {
    throw controlsUnavailable();
  }
}

export interface MatterAccessoryBinding {
  stop(): void | Promise<void>;
}

export interface MatterAccessoryLogger {
  error(message: string): void;
}

export function wave3RoomAirConditionerDeviceType(
  currentTemperatureSource: CurrentTemperatureSource,
) {
  const requirements = devices.RoomAirConditionerRequirements;
  const thermostat = currentTemperatureSource === 'none'
    ? Wave3NoTemperatureThermostatServer
    : Wave3ThermostatServer;

  return currentTemperatureSource === 'ambient'
    ? devices.RoomAirConditionerDevice.with(
      Wave3OnOffServer,
      thermostat,
      Wave3FanControlServer,
      requirements.RelativeHumidityMeasurementServer,
    )
    : devices.RoomAirConditionerDevice.with(
      Wave3OnOffServer,
      thermostat,
      Wave3FanControlServer,
    );
}

export function createWave3MatterAccessory(
  matter: MatterAPI,
  uuid: string,
  device: Wave3DeviceConfig,
  snapshot: Wave3ControllerSnapshot,
  cached?: MatterAccessory<Wave3MatterAccessoryContext>,
): MatterAccessory<Wave3MatterAccessoryContext> {
  const cachedContext = cached?.context;
  const firmwareRevision = snapshot.firmwareVersions?.pd
    ?? snapshot.firmwareVersions?.iot
    ?? cachedContext?.firmwareRevision
    ?? cached?.firmwareRevision;
  const context: Wave3MatterAccessoryContext = {
    schemaVersion: 1,
    serialNumber: device.serialNumber,
    currentTemperatureSource: device.currentTemperatureSource,
    lastSystemMode: validSystemMode(cachedContext?.lastSystemMode)
      ?? MATTER_SYSTEM_MODE.cool,
    ...(firmwareRevision === undefined ? {} : { firmwareRevision }),
  };
  const clusters = clustersForSnapshot(
    snapshot,
    device.currentTemperatureSource,
    context,
    cached?.clusters,
  );
  rememberDesiredState(uuid, clusters);
  return {
    UUID: uuid,
    displayName: device.name,
    deviceType: wave3RoomAirConditionerDeviceType(device.currentTemperatureSource),
    manufacturer: 'EcoFlow',
    model: 'WAVE 3',
    serialNumber: device.serialNumber,
    ...(firmwareRevision === undefined ? {} : { firmwareRevision }),
    context,
    clusters,
  };
}

export class Wave3MatterAccessory implements MatterAccessoryBinding {
  private readonly detachSnapshot: () => void;
  private updateTail: Promise<void> = Promise.resolve();
  private presentedFirmwareRevision?: string;
  private stopped = false;

  constructor(
    private readonly matter: MatterAPI,
    private readonly accessory: MatterAccessory<Wave3MatterAccessoryContext>,
    controller: Wave3AccessoryController,
    private readonly currentTemperatureSource: CurrentTemperatureSource,
    private readonly logger: MatterAccessoryLogger = { error: () => undefined },
  ) {
    this.updateTail = this.pushFirmware(
      controller.snapshot.firmwareVersions?.pd
      ?? controller.snapshot.firmwareVersions?.iot
      ?? accessory.context.firmwareRevision
      ?? accessory.firmwareRevision,
    ).catch(() => {
      this.logger.error('EcoFlow WAVE 3 Matter firmware update failed');
    });
    this.detachSnapshot = controller.onSnapshot(snapshot => {
      this.updateTail = this.updateTail
        .then(() => this.pushSnapshot(snapshot))
        .catch(() => {
          this.logger.error('EcoFlow WAVE 3 Matter state update failed');
        });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.updateTail;
      return;
    }
    this.stopped = true;
    this.detachSnapshot();
    forgetDesiredState(this.accessory.UUID);
    await this.updateTail;
    forgetDesiredState(this.accessory.UUID);
  }

  private async pushSnapshot(snapshot: Wave3ControllerSnapshot): Promise<void> {
    if (this.stopped) {
      return;
    }

    await this.pushFirmware(snapshot.firmwareVersions?.pd ?? snapshot.firmwareVersions?.iot);

    if (this.stopped || snapshot.availability !== 'online') {
      return;
    }

    const clusters = clustersForSnapshot(
      snapshot,
      this.currentTemperatureSource,
      this.accessory.context,
      this.accessory.clusters,
    );
    this.accessory.clusters = clusters;
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.OnOff,
      clusters.onOff ?? {},
    );
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.Thermostat,
      clusters.thermostat ?? {},
    );
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.FanControl,
      clusters.fanControl ?? {},
    );
    if (this.currentTemperatureSource === 'ambient') {
      await this.updateState(
        this.accessory.UUID,
        this.matter.clusterNames.RelativeHumidityMeasurement,
        clusters.relativeHumidityMeasurement ?? {},
      );
    }
  }

  private async updateState(
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>,
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    rememberDesiredCluster(uuid, cluster, attributes);
    await this.matter.updateAccessoryState(uuid, cluster, attributes);
    if (!await waitForAttributes(this.matter, uuid, cluster, attributes)) {
      throw new Error('Matter state update was not confirmed by Homebridge');
    }
  }

  private async pushFirmware(firmwareRevision: string | undefined): Promise<void> {
    if (firmwareRevision === undefined || firmwareRevision === this.presentedFirmwareRevision) {
      return;
    }
    const cluster = this.matter.clusterNames.BridgedDeviceBasicInformation;
    const attributes = {
      softwareVersion: packedFirmwareVersion(firmwareRevision),
      softwareVersionString: firmwareRevision,
    };
    const ready = await waitForCluster(this.matter, this.accessory.UUID, cluster);
    if (!ready || this.stopped) {
      return;
    }
    await this.matter.updateAccessoryState(
      this.accessory.UUID,
      cluster,
      attributes,
    );
    if (this.stopped) {
      return;
    }
    if (!await waitForAttributes(this.matter, this.accessory.UUID, cluster, attributes)) {
      return;
    }
    if (this.stopped) {
      return;
    }
    this.accessory.firmwareRevision = firmwareRevision;
    this.accessory.context.firmwareRevision = firmwareRevision;
    this.presentedFirmwareRevision = firmwareRevision;
  }
}

function clustersForSnapshot(
  snapshot: Wave3ControllerSnapshot,
  currentTemperatureSource: CurrentTemperatureSource,
  context: Wave3MatterAccessoryContext,
  previous: MatterAccessory['clusters'] = {},
): NonNullable<MatterAccessory['clusters']> {
  const state = snapshot.state;
  if (snapshot.availability === 'online') {
    const systemMode = systemModeForState(state.mode, state.submode);
    if (systemMode !== undefined) {
      context.lastSystemMode = systemMode;
    }
  }

  const previousThermostat = previous?.thermostat ?? {};
  const previousFan = previous?.fanControl ?? {};
  const temperature = currentTemperatureSource === 'ambient'
    ? state.ambientTemperatureCelsius
    : currentTemperatureSource === 'outlet'
      ? state.outletTemperatureCelsius
      : undefined;
  const coolingSetpoint = state.mode === 'auto'
    ? state.targetTemperatureUpperCelsius
    : state.mode === 'cool'
      ? state.targetTemperatureCelsius
      : undefined;
  const heatingSetpoint = state.mode === 'auto'
    ? state.targetTemperatureLowerCelsius
    : state.mode === 'heat'
      ? state.targetTemperatureCelsius
      : undefined;
  const airflow = normalizedAirflow(state.airflowSpeed)
    ?? numberOrUndefined(previousFan.percentSetting)
    ?? 20;
  const powered = state.powered
    ?? booleanOrUndefined(previous?.onOff?.onOff)
    ?? false;

  const clusters: NonNullable<MatterAccessory['clusters']> = {
    ...previous,
    onOff: { onOff: powered },
    thermostat: {
      ...previousThermostat,
      localTemperature: currentTemperatureSource === 'none'
        ? null
        : temperature === undefined
          ? nullableNumber(previousThermostat.localTemperature)
          : centidegrees(temperature),
      occupiedCoolingSetpoint: coolingSetpoint === undefined
        ? numberOrUndefined(previousThermostat.occupiedCoolingSetpoint)
          ?? DEFAULT_TEMPERATURE_CENTIDEGREES
        : centidegrees(coolingSetpoint),
      occupiedHeatingSetpoint: heatingSetpoint === undefined
        ? numberOrUndefined(previousThermostat.occupiedHeatingSetpoint)
          ?? DEFAULT_TEMPERATURE_CENTIDEGREES
        : centidegrees(heatingSetpoint),
      controlSequenceOfOperation: 4,
      systemMode: context.lastSystemMode ?? MATTER_SYSTEM_MODE.cool,
      thermostatRunningMode: runningModeForState(powered, state.mode),
    },
    fanControl: {
      ...previousFan,
      fanMode: powered ? fanModeForAirflow(airflow) : MATTER_FAN_MODE.off,
      fanModeSequence: 0,
      percentSetting: powered ? airflow : 0,
      percentCurrent: powered ? airflow : 0,
      speedMax: 5,
      speedSetting: powered ? speedIndex(airflow) : 0,
      speedCurrent: powered ? speedIndex(airflow) : 0,
    },
  };

  if (currentTemperatureSource === 'ambient') {
    clusters.relativeHumidityMeasurement = {
      measuredValue: state.ambientHumidityPercent === undefined
        ? nullableNumber(previous?.relativeHumidityMeasurement?.measuredValue)
        : centipercent(state.ambientHumidityPercent),
      minMeasuredValue: 0,
      maxMeasuredValue: 10_000,
    };
  } else {
    delete clusters.relativeHumidityMeasurement;
  }

  return clusters;
}

function rememberDesiredState(
  uuid: string,
  clusters: NonNullable<MatterAccessory['clusters']>,
): void {
  for (const [cluster, attributes] of Object.entries(clusters)) {
    rememberDesiredCluster(uuid, cluster, attributes);
  }
}

function forgetDesiredState(uuid: string): void {
  const prefix = `${uuid}\u0000`;
  for (const key of desiredMatterState.keys()) {
    if (key.startsWith(prefix)) {
      desiredMatterState.delete(key);
    }
  }
}

function rememberDesiredCluster(
  uuid: string,
  cluster: string,
  attributes: Record<string, unknown>,
): void {
  for (const [attribute, value] of Object.entries(attributes)) {
    desiredMatterState.set(desiredStateKey(uuid, cluster, attribute), value);
  }
}

function requireDesiredValue(
  uuid: string,
  cluster: string,
  attribute: string,
  value: unknown,
): void {
  if (!Object.is(desiredMatterState.get(desiredStateKey(uuid, cluster, attribute)), value)) {
    throw controlsUnavailable();
  }
}

function desiredStateKey(uuid: string, cluster: string, attribute: string): string {
  return `${uuid}\u0000${cluster}\u0000${attribute}`;
}

function controlsUnavailable(): Error {
  return new Error('Matter controls are unavailable until command mapping is initialized');
}

async function waitForCluster(
  matter: MatterAPI,
  uuid: string,
  cluster: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (await matter.getAccessoryState(uuid, cluster) !== undefined) {
        return true;
      }
    } catch {
      // Homebridge reports a missing endpoint while bridged registration is in flight.
    }
    await delay(25);
  }
  return false;
}

async function waitForAttributes(
  matter: MatterAPI,
  uuid: string,
  cluster: string,
  expected: Record<string, unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const state = await matter.getAccessoryState(uuid, cluster);
      if (state !== undefined && Object.entries(expected).every(
        ([attribute, value]) => Object.is(state[attribute], value),
      )) {
        return true;
      }
    } catch {
      // Retry while Homebridge finishes endpoint registration or a deferred update.
    }
    await delay(25);
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function packedFirmwareVersion(version: string): number {
  const parts = version.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return 1;
  }
  return (
    ((parts[0]! << 24) >>> 0)
    | (parts[1]! << 16)
    | (parts[2]! << 8)
    | parts[3]!
  ) >>> 0;
}

function systemModeForState(mode: Wave3Mode | undefined, submode: number | undefined): number | undefined {
  if (submode === 3 && mode !== 'off') {
    return MATTER_SYSTEM_MODE.sleep;
  }
  if (mode === undefined || mode === 'off') {
    return undefined;
  }
  return MATTER_SYSTEM_MODE[mode];
}

function runningModeForState(powered: boolean, mode: Wave3Mode | undefined): number {
  if (!powered) {
    return MATTER_RUNNING_MODE.off;
  }
  if (mode === 'cool') {
    return MATTER_RUNNING_MODE.cool;
  }
  if (mode === 'heat') {
    return MATTER_RUNNING_MODE.heat;
  }
  return MATTER_RUNNING_MODE.off;
}

function normalizedAirflow(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(20, Math.min(100, Math.round(value / 20) * 20));
}

function fanModeForAirflow(airflow: number): number {
  if (airflow <= 40) {
    return MATTER_FAN_MODE.low;
  }
  if (airflow <= 60) {
    return MATTER_FAN_MODE.medium;
  }
  return MATTER_FAN_MODE.high;
}

function speedIndex(percent: number): number {
  return Math.max(1, Math.min(5, Math.round(percent / 20)));
}

function centidegrees(value: number): number {
  return Math.round(value * 100);
}

function centipercent(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value * 100)));
}

function validSystemMode(value: unknown): number | undefined {
  return typeof value === 'number' && Object.values(MATTER_SYSTEM_MODE).includes(
    value as (typeof MATTER_SYSTEM_MODE)[keyof typeof MATTER_SYSTEM_MODE],
  ) ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}
