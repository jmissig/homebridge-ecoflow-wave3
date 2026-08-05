import type { MatterAccessory } from 'homebridge';

import type { Wave3ControllerSnapshot, Wave3Mode } from '../wave3/domain.js';
import type { Wave3MatterAccessoryContext } from './context.js';
import {
  DEFAULT_TEMPERATURE_CENTIDEGREES,
  MATTER_FAN_MODE,
  MATTER_SYSTEM_MODE,
  MATTER_TEMPERATURE_DISPLAY_MODE,
} from './constants.js';

export function clustersForSnapshot(
  snapshot: Wave3ControllerSnapshot,
  context: Wave3MatterAccessoryContext,
  previous: MatterAccessory['clusters'] = {},
): NonNullable<MatterAccessory['clusters']> {
  const state = snapshot.state;
  const previousThermostat = previous?.thermostat ?? {};
  const previousFan = previous?.fanControl ?? {};
  const previousThermostatUi = previous?.thermostatUserInterfaceConfiguration ?? {};
  const profiles = snapshot.modeProfiles;
  const temperature = state.ambientTemperatureCelsius;
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
  const activeManualSetpoint = (state.mode === 'cool' || state.mode === 'heat')
    ? state.targetTemperatureCelsius
    : undefined;
  let projectedCoolingSetpoint: number;
  let projectedHeatingSetpoint: number;
  if (activeManualSetpoint !== undefined) {
    // The WAVE owns independent Cool and Heat profiles, while Apple Home
    // presents one active target for this manual-only Matter thermostat.
    // Mirror the confirmed active profile into both constrained Matter
    // attributes; never collapse or copy the inactive WAVE profile itself.
    projectedCoolingSetpoint = centidegrees(activeManualSetpoint);
    projectedHeatingSetpoint = projectedCoolingSetpoint;
  } else {
    projectedCoolingSetpoint = coolingSetpoint === undefined
      ? numberOrUndefined(previousThermostat.occupiedCoolingSetpoint)
        ?? DEFAULT_TEMPERATURE_CENTIDEGREES
      : centidegrees(coolingSetpoint);
    projectedHeatingSetpoint = heatingSetpoint === undefined
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
      localTemperature: temperature === undefined
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
    thermostatUserInterfaceConfiguration: {
      ...previousThermostatUi,
      temperatureDisplayMode: state.temperatureDisplayUnit === 'fahrenheit'
        ? MATTER_TEMPERATURE_DISPLAY_MODE.fahrenheit
        : state.temperatureDisplayUnit === 'celsius'
          ? MATTER_TEMPERATURE_DISPLAY_MODE.celsius
          : numberOrUndefined(previousThermostatUi.temperatureDisplayMode)
            ?? MATTER_TEMPERATURE_DISPLAY_MODE.celsius,
      keypadLockout: 0,
    },
  };

  delete clusters.thermostat?.thermostatRunningMode;
  // Remove the Auto-only attribute from older cached endpoint state when the
  // Auto feature is no longer advertised.
  delete clusters.thermostat?.minSetpointDeadBand;

  clusters.relativeHumidityMeasurement = {
    measuredValue: state.ambientHumidityPercent === undefined
      ? nullableNumber(previous?.relativeHumidityMeasurement?.measuredValue)
      : centipercent(state.ambientHumidityPercent),
    minMeasuredValue: 0,
    maxMeasuredValue: 10_000,
  };

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
  // Apple Home currently presents Auto for this Room Air Conditioner but does
  // not write Thermostat.SystemMode=Auto, and it ignores authoritative Auto
  // reports. Keep WAVE Auto available to the protocol/domain layer, but expose
  // an externally selected Auto profile as Cool at its upper threshold until
  // controller interoperability is good enough to advertise Auto again.
  if (mode === 'auto') {
    return MATTER_SYSTEM_MODE.cool;
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
