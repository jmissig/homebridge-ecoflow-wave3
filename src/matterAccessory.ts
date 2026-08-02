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
      requirements.FanControlServer,
      requirements.RelativeHumidityMeasurementServer,
    )
    : devices.RoomAirConditionerDevice.with(
      thermostat,
      requirements.FanControlServer,
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
  const context: Wave3MatterAccessoryContext = {
    schemaVersion: 1,
    serialNumber: device.serialNumber,
    currentTemperatureSource: device.currentTemperatureSource,
    lastSystemMode: validSystemMode(cachedContext?.lastSystemMode)
      ?? MATTER_SYSTEM_MODE.cool,
  };
  const clusters = clustersForSnapshot(
    snapshot,
    device.currentTemperatureSource,
    context,
    cached?.clusters,
  );
  const firmwareRevision = snapshot.firmwareVersions?.pd
    ?? snapshot.firmwareVersions?.iot
    ?? cached?.firmwareRevision;

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
  private stopped = false;

  constructor(
    private readonly matter: MatterAPI,
    private readonly accessory: MatterAccessory<Wave3MatterAccessoryContext>,
    controller: Wave3AccessoryController,
    private readonly currentTemperatureSource: CurrentTemperatureSource,
    private readonly logger: MatterAccessoryLogger = { error: () => undefined },
  ) {
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

    const firmwareRevision = snapshot.firmwareVersions?.pd
      ?? snapshot.firmwareVersions?.iot;
    if (firmwareRevision !== undefined && firmwareRevision !== this.accessory.firmwareRevision) {
      this.accessory.firmwareRevision = firmwareRevision;
      await this.matter.updatePlatformAccessories([this.accessory]);
    }

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
    await this.matter.updateAccessoryState(
      this.accessory.UUID,
      this.matter.clusterNames.OnOff,
      clusters.onOff ?? {},
    );
    await this.matter.updateAccessoryState(
      this.accessory.UUID,
      this.matter.clusterNames.Thermostat,
      clusters.thermostat ?? {},
    );
    await this.matter.updateAccessoryState(
      this.accessory.UUID,
      this.matter.clusterNames.FanControl,
      clusters.fanControl ?? {},
    );
    if (this.currentTemperatureSource === 'ambient') {
      await this.matter.updateAccessoryState(
        this.accessory.UUID,
        this.matter.clusterNames.RelativeHumidityMeasurement,
        clusters.relativeHumidityMeasurement ?? {},
      );
    }
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
