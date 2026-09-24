import type { MatterAccessory } from 'homebridge';

import type { Wave3ControllerSnapshot } from '../wave3/domain.js';
import { MATTER_FAN_MODE } from './constants.js';

export function usesStoragePresentation(
  seasonalStorage: boolean,
  snapshot: Wave3ControllerSnapshot,
): boolean {
  return seasonalStorage && snapshot.availability !== 'online';
}

/** Explicit virtual Off presentation, never a source of device/control authority. */
export function storageClusters(
  clusters: NonNullable<MatterAccessory['clusters']>,
): NonNullable<MatterAccessory['clusters']> {
  return {
    ...clusters,
    onOff: { ...clusters.onOff, onOff: false },
    thermostat: { ...clusters.thermostat, localTemperature: null },
    fanControl: {
      ...clusters.fanControl,
      fanMode: MATTER_FAN_MODE.off,
      percentSetting: 0,
      percentCurrent: 0,
      speedSetting: 0,
      speedCurrent: 0,
    },
    relativeHumidityMeasurement: { ...clusters.relativeHumidityMeasurement, measuredValue: null },
    electricalPowerMeasurement: { ...clusters.electricalPowerMeasurement, activePower: null },
    bridgedDeviceBasicInformation: { ...clusters.bridgedDeviceBasicInformation, reachable: true },
  };
}
