import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planWave3ModeTransition,
  planWave3TemperatureIntent,
} from '../src/wave3/intentPlanner.js';

describe('WAVE 3 semantic intent planner', () => {
  it('carries the destination profile target on cool and heat transitions', () => {
    assert.deepEqual(planWave3ModeTransition('cool', {
      presentedCoolingCelsius: 22,
    }), {
      type: 'mode',
      mode: 'cool',
      targetTemperatureCelsius: 22,
    });
    assert.deepEqual(planWave3ModeTransition('heat', {
      presentedHeatingCelsius: 20,
      stagedHeatingCelsius: 20.5,
    }), {
      type: 'mode',
      mode: 'heat',
      targetTemperatureCelsius: 20.5,
    });
  });

  it('preserves and reconciles automatic profile ranges', () => {
    assert.deepEqual(planWave3ModeTransition('auto', {
      presentedHeatingCelsius: 19,
      presentedCoolingCelsius: 24,
    }), {
      type: 'mode',
      mode: 'auto',
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
    });
    assert.deepEqual(planWave3ModeTransition('auto', {
      presentedHeatingCelsius: 19,
      presentedCoolingCelsius: 24,
      stagedHeatingCelsius: 25,
    }), {
      type: 'mode',
      mode: 'auto',
      targetTemperatureLowerCelsius: 25,
      targetTemperatureUpperCelsius: 25,
    });
  });

  it('plans active setpoints and suppresses no-ops and inactive companions', () => {
    assert.deepEqual(planWave3TemperatureIntent({
      mode: 'cool',
      targetTemperatureCelsius: 22,
    }, { coolingCelsius: 23 }), {
      status: 'command',
      command: { type: 'targetTemperature', celsius: 23 },
    });
    assert.deepEqual(planWave3TemperatureIntent({
      mode: 'heat',
      targetTemperatureCelsius: 20.8,
    }, { heatingCelsius: 20.8 }), { status: 'noop' });
    assert.deepEqual(planWave3TemperatureIntent({
      mode: 'cool',
      targetTemperatureCelsius: 22,
    }, { heatingCelsius: 20 }), { status: 'noop' });
  });

  it('plans automatic range changes and reports an unknown baseline', () => {
    assert.deepEqual(planWave3TemperatureIntent({
      mode: 'auto',
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
    }, { heatingCelsius: 25 }), {
      status: 'command',
      command: {
        type: 'automaticTemperatureRange',
        lowerCelsius: 25,
        upperCelsius: 25,
      },
    });
    assert.deepEqual(planWave3TemperatureIntent({ mode: 'auto' }, {
      heatingCelsius: 20,
    }), { status: 'missingAutomaticRange' });
  });
});
