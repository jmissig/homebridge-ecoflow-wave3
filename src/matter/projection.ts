import type { MatterAccessory } from 'homebridge';

import type { CurrentTemperatureSource } from '../ecoflow/config.js';
import type { Wave3ControllerSnapshot, Wave3Mode } from '../wave3/domain.js';
import type { Wave3MatterAccessoryContext } from './context.js';
import {
  DEFAULT_TEMPERATURE_CENTIDEGREES,
  MATTER_FAN_MODE,
  MATTER_SYSTEM_MODE,
} from './constants.js';

export function clustersForSnapshot(
  snapshot: Wave3ControllerSnapshot,
  currentTemperatureSource: CurrentTemperatureSource,
  context: Wave3MatterAccessoryContext,
  previous: MatterAccessory['clusters'] = {},
): NonNullable<MatterAccessory['clusters']> {
  const state = snapshot.state;
  const previousThermostat = previous?.thermostat ?? {};
  const previousFan = previous?.fanControl ?? {};
  const profiles = snapshot.modeProfiles;
  const temperature = currentTemperatureSource === 'ambient'
    ? state.ambientTemperatureCelsius
    : currentTemperatureSource === 'outlet'
      ? state.outletTemperatureCelsius
      : undefined;
  const coolingSetpoint = state.mode === 'auto'
    ? state.targetTemperatureUpperCelsius
    : state.mode === 'cool'
      ? state.targetTemperatureCelsius
      : profiles.cool?.targetTemperatureCelsius;
  const heatingSetpoint = state.mode === 'auto'
    ? state.targetTemperatureLowerCelsius
    : state.mode === 'heat'
      ? state.targetTemperatureCelsius
      : profiles.heat?.targetTemperatureCelsius;
  let projectedCoolingSetpoint = coolingSetpoint === undefined
    ? numberOrUndefined(previousThermostat.occupiedCoolingSetpoint)
      ?? DEFAULT_TEMPERATURE_CENTIDEGREES
    : centidegrees(coolingSetpoint);
  let projectedHeatingSetpoint = heatingSetpoint === undefined
    ? numberOrUndefined(previousThermostat.occupiedHeatingSetpoint)
      ?? DEFAULT_TEMPERATURE_CENTIDEGREES
    : centidegrees(heatingSetpoint);
  if (projectedHeatingSetpoint > projectedCoolingSetpoint) {
    if (heatingSetpoint !== undefined && coolingSetpoint === undefined) {
      projectedCoolingSetpoint = projectedHeatingSetpoint;
    } else {
      projectedHeatingSetpoint = projectedCoolingSetpoint;
    }
  }
  const airflow = normalizedAirflow(state.airflowSpeed)
    ?? numberOrUndefined(previousFan.percentSetting)
    ?? 20;
  const powered = state.powered
    ?? booleanOrUndefined(previous?.onOff?.onOff)
    ?? false;
  const projectedSystemMode = context.lastSystemMode ?? MATTER_SYSTEM_MODE.cool;

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
      occupiedCoolingSetpoint: projectedCoolingSetpoint,
      occupiedHeatingSetpoint: projectedHeatingSetpoint,
      absMinHeatSetpointLimit: 1_600,
      minHeatSetpointLimit: 1_600,
      maxHeatSetpointLimit: 3_000,
      absMaxHeatSetpointLimit: 3_000,
      absMinCoolSetpointLimit: 1_600,
      minCoolSetpointLimit: 1_600,
      maxCoolSetpointLimit: 3_000,
      absMaxCoolSetpointLimit: 3_000,
      // Matter applies its deadband globally to inactive companion setpoints,
      // which would incorrectly narrow WAVE's 16–30 C single-mode range.
      // Keep the cluster constraint disabled and enforce WAVE's observed 4 C
      // automatic-mode minimum in the semantic command planner instead.
      minSetpointDeadBand: 0,
      controlSequenceOfOperation: 4,
      systemMode: projectedSystemMode,
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

  delete clusters.thermostat?.thermostatRunningMode;

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

export function systemModeForState(
  mode: Wave3Mode | undefined,
  submode: number | undefined,
): number | undefined {
  if (submode === 3 && mode !== 'off') {
    return MATTER_SYSTEM_MODE.sleep;
  }
  if (mode === undefined || mode === 'off') {
    return undefined;
  }
  return MATTER_SYSTEM_MODE[mode];
}

export function normalizedAirflow(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(20, Math.min(100, Math.round(value / 20) * 20));
}

export function fanModeForAirflow(airflow: number): number {
  if (airflow <= 33) {
    return MATTER_FAN_MODE.low;
  }
  if (airflow <= 66) {
    return MATTER_FAN_MODE.medium;
  }
  return MATTER_FAN_MODE.high;
}

export function speedIndex(percent: number): number {
  return Math.max(1, Math.min(5, Math.round(percent / 20)));
}

export function centidegrees(value: number): number {
  return Math.round(value * 100);
}

export function centipercent(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value * 100)));
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function nullableNumber(value: unknown): number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}
