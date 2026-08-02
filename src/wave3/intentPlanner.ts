import type {
  Wave3Command,
  Wave3ControllableMode,
  Wave3ModeCommand,
  Wave3State,
} from './domain.js';

export interface Wave3ModeTargetIntent {
  presentedHeatingCelsius?: number;
  presentedCoolingCelsius?: number;
  stagedHeatingCelsius?: number;
  stagedCoolingCelsius?: number;
}

export interface Wave3TemperatureIntent {
  heatingCelsius?: number;
  coolingCelsius?: number;
}

export type Wave3TemperaturePlan =
  | { status: 'command'; command: Wave3Command }
  | { status: 'noop' }
  | { status: 'inactive' }
  | { status: 'missingAutomaticRange' };

/**
 * Compile a WAVE mode transition with the destination profile values that the
 * controller currently presents. WAVE profiles are independent: sending only
 * a mode can restore the appliance's older saved target instead.
 */
export function planWave3ModeTransition(
  mode: Wave3ControllableMode,
  intent: Wave3ModeTargetIntent,
): Wave3ModeCommand {
  if (mode === 'cool') {
    return {
      type: 'mode',
      mode,
      targetTemperatureCelsius: intent.stagedCoolingCelsius
        ?? intent.presentedCoolingCelsius,
    };
  }
  if (mode === 'heat') {
    return {
      type: 'mode',
      mode,
      targetTemperatureCelsius: intent.stagedHeatingCelsius
        ?? intent.presentedHeatingCelsius,
    };
  }
  if (mode === 'auto') {
    let lower = intent.stagedHeatingCelsius ?? intent.presentedHeatingCelsius;
    let upper = intent.stagedCoolingCelsius ?? intent.presentedCoolingCelsius;
    if (lower === undefined || upper === undefined) {
      return { type: 'mode', mode };
    }
    if (lower > upper) {
      if (intent.stagedHeatingCelsius !== undefined
        && intent.stagedCoolingCelsius === undefined) {
        upper = lower;
      } else {
        lower = upper;
      }
    }
    return {
      type: 'mode',
      mode,
      targetTemperatureLowerCelsius: lower,
      targetTemperatureUpperCelsius: upper,
    };
  }
  return { type: 'mode', mode };
}

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
    if (lowerCelsius > upperCelsius) {
      if (intent.heatingCelsius !== undefined && intent.coolingCelsius === undefined) {
        upperCelsius = lowerCelsius;
      } else {
        lowerCelsius = upperCelsius;
      }
    }
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
