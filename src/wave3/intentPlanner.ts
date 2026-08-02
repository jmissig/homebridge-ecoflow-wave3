import type {
  Wave3Command,
  Wave3State,
} from './domain.js';

export const WAVE3_AUTO_MIN_DEADBAND_CELSIUS = 4;

export interface Wave3TemperatureIntent {
  heatingCelsius?: number;
  coolingCelsius?: number;
}

export type Wave3TemperaturePlan =
  | { status: 'command'; command: Wave3Command }
  | { status: 'noop' }
  | { status: 'inactive' }
  | { status: 'missingAutomaticRange' };

/** Plan an active setpoint update without importing Matter error semantics. */
export function planWave3TemperatureIntent(
  state: Readonly<Wave3State>,
  intent: Wave3TemperatureIntent,
): Wave3TemperaturePlan {
  if (state.mode === 'auto') {
    let lowerCelsius = intent.heatingCelsius ?? state.targetTemperatureLowerCelsius;
    let upperCelsius = intent.coolingCelsius ?? state.targetTemperatureUpperCelsius;
    if (lowerCelsius === undefined || upperCelsius === undefined) {
      return { status: 'missingAutomaticRange' };
    }
    [lowerCelsius, upperCelsius] = constrainWave3AutomaticRange(
      lowerCelsius,
      upperCelsius,
      intent.heatingCelsius !== undefined && intent.coolingCelsius === undefined
        ? 'lower'
        : intent.coolingCelsius !== undefined && intent.heatingCelsius === undefined
          ? 'upper'
          : 'both',
    );
    if (state.targetTemperatureLowerCelsius === lowerCelsius
      && state.targetTemperatureUpperCelsius === upperCelsius) {
      return { status: 'noop' };
    }
    return {
      status: 'command',
      command: {
        type: 'automaticTemperatureRange',
        lowerCelsius,
        upperCelsius,
      },
    };
  }

  const activeCelsius = state.mode === 'heat'
    ? intent.heatingCelsius
    : state.mode === 'cool'
      ? intent.coolingCelsius
      : undefined;
  if (activeCelsius !== undefined) {
    return state.targetTemperatureCelsius === activeCelsius
      ? { status: 'noop' }
      : {
        status: 'command',
        command: { type: 'targetTemperature', celsius: activeCelsius },
      };
  }

  // Matter may move the inactive companion setpoint to preserve thermostat
  // constraints. That value is not a second WAVE target.
  if ((intent.heatingCelsius !== undefined && state.mode === 'cool')
    || (intent.coolingCelsius !== undefined && state.mode === 'heat')) {
    return { status: 'noop' };
  }
  return { status: 'inactive' };
}

/**
 * Preserve the WAVE app's observed four-degree automatic-mode range. Matter
 * controllers may transiently stage crossing or collapsed companion values,
 * so normalize them before they reach the appliance.
 */
export function constrainWave3AutomaticRange(
  requestedLower: number,
  requestedUpper: number,
  preferredEdge: 'lower' | 'upper' | 'both' = 'both',
): readonly [number, number] {
  let lower = clampTemperature(requestedLower);
  let upper = clampTemperature(requestedUpper);
  if (upper - lower >= WAVE3_AUTO_MIN_DEADBAND_CELSIUS) {
    return [roundedTenth(lower), roundedTenth(upper)];
  }

  if (preferredEdge === 'lower') {
    lower = Math.min(lower, 30 - WAVE3_AUTO_MIN_DEADBAND_CELSIUS);
    upper = Math.max(upper, lower + WAVE3_AUTO_MIN_DEADBAND_CELSIUS);
  } else if (preferredEdge === 'upper') {
    upper = Math.max(upper, 16 + WAVE3_AUTO_MIN_DEADBAND_CELSIUS);
    lower = Math.min(lower, upper - WAVE3_AUTO_MIN_DEADBAND_CELSIUS);
  } else {
    const midpoint = Math.max(18, Math.min(28, (lower + upper) / 2));
    lower = midpoint - WAVE3_AUTO_MIN_DEADBAND_CELSIUS / 2;
    upper = midpoint + WAVE3_AUTO_MIN_DEADBAND_CELSIUS / 2;
  }
  return [roundedTenth(lower), roundedTenth(upper)];
}

function clampTemperature(value: number): number {
  return Math.max(16, Math.min(30, value));
}

function roundedTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
