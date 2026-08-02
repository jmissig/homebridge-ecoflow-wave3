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
  on: 0x04,
} as const;

const snapshotClusterUpdates = new Set<string>();
const MultiSpeedFanControlServer = devices.RoomAirConditionerRequirements.FanControlServer.with(
  'MultiSpeed',
);

class Wave3FanControlServer extends MultiSpeedFanControlServer {
  override initialize(): void {
    super.initialize();
    this.reactTo(this.events.fanMode$Changing, this.rejectControllerWrite, { offline: true });
    this.reactTo(this.events.percentSetting$Changing, this.rejectControllerWrite, { offline: true });
    this.reactTo(this.events.speedSetting$Changing, this.rejectControllerWrite, { offline: true });
  }

  private rejectControllerWrite(): void {
    requireSnapshotUpdate(this.endpoint.id, 'fanControl');
  }
}

export interface MatterAccessoryBinding {
  stop(): void;
}

export interface MatterAccessoryLogger {
  error(message: string): void;
}

export function wave3RoomAirConditionerDeviceType(
  currentTemperatureSource: CurrentTemperatureSource,
) {
  const requirements = devices.RoomAirConditionerRequirements;
  const thermostat = currentTemperatureSource === 'none'
    ? requirements.ThermostatServer.with(
      'Heating',
      'Cooling',
      'AutoMode',
      'LocalTemperatureNotExposed',
    )
    : requirements.ThermostatServer.with('Heating', 'Cooling', 'AutoMode');

  return currentTemperatureSource === 'ambient'
    ? devices.RoomAirConditionerDevice.with(
      thermostat,
      Wave3FanControlServer,
      requirements.RelativeHumidityMeasurementServer,
    )
    : devices.RoomAirConditionerDevice.with(
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
    handlers: rejectingMatterHandlers(uuid),
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

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.detachSnapshot();
  }

  private async pushSnapshot(snapshot: Wave3ControllerSnapshot): Promise<void> {
    if (this.stopped) {
      return;
    }

    await this.pushFirmware(snapshot.firmwareVersions?.pd ?? snapshot.firmwareVersions?.iot);

    if (snapshot.availability !== 'online') {
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
    const key = snapshotUpdateKey(uuid, cluster);
    snapshotClusterUpdates.add(key);
    try {
      await this.matter.updateAccessoryState(uuid, cluster, attributes);
    } finally {
      snapshotClusterUpdates.delete(key);
    }
  }

  private async pushFirmware(firmwareRevision: string | undefined): Promise<void> {
    if (firmwareRevision === undefined || firmwareRevision === this.presentedFirmwareRevision) {
      return;
    }
    await this.matter.updateAccessoryState(
      this.accessory.UUID,
      this.matter.clusterNames.BridgedDeviceBasicInformation,
      {
        softwareVersion: packedFirmwareVersion(firmwareRevision),
        softwareVersionString: firmwareRevision,
      },
    );
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
      systemMode: context.lastSystemMode ?? MATTER_SYSTEM_MODE.cool,
      thermostatRunningMode: runningModeForState(powered, state.mode),
    },
    fanControl: {
      ...previousFan,
      fanMode: powered ? MATTER_FAN_MODE.on : MATTER_FAN_MODE.off,
      fanModeSequence: 0,
      percentSetting: airflow,
      percentCurrent: powered ? airflow : 0,
      speedMax: 5,
      speedSetting: speedIndex(airflow),
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

function rejectingMatterHandlers(uuid: string): NonNullable<MatterAccessory['handlers']> {
  const allowSnapshotOnOff = () => requireSnapshotUpdate(uuid, 'onOff');
  const allowSnapshotThermostat = () => requireSnapshotUpdate(uuid, 'thermostat');
  return {
    onOff: {
      on: allowSnapshotOnOff,
      off: allowSnapshotOnOff,
      toggle: allowSnapshotOnOff,
    },
    thermostat: {
      systemModeChange: allowSnapshotThermostat,
      occupiedHeatingSetpointChange: allowSnapshotThermostat,
      occupiedCoolingSetpointChange: allowSnapshotThermostat,
      setpointRaiseLower: allowSnapshotThermostat,
    },
  };
}

function requireSnapshotUpdate(uuid: string, cluster: string): void {
  if (!snapshotClusterUpdates.has(snapshotUpdateKey(uuid, cluster))) {
    throw new Error('Matter controls are unavailable until command mapping is initialized');
  }
}

function snapshotUpdateKey(uuid: string, cluster: string): string {
  return `${uuid}\u0000${cluster}`;
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
