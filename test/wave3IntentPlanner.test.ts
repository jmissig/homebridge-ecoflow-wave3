import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  constrainWave3AutomaticRange,
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
      profile: { targetTemperatureCelsius: 26 },
      presentedHeatingCelsius: 20,
    }), {
      type: 'mode',
      mode: 'heat',
      targetTemperatureCelsius: 26,
    });
    assert.deepEqual(planWave3ModeTransition('heat', {
      profile: { targetTemperatureCelsius: 26 },
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
      profile: {
        targetTemperatureLowerCelsius: 19,
        targetTemperatureUpperCelsius: 24,
      },
      presentedHeatingCelsius: 21,
      presentedCoolingCelsius: 21,
    }), {
      type: 'mode',
      mode: 'auto',
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
    });
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
      targetTemperatureUpperCelsius: 29,
    });
  });

  it('enforces the observed four-degree automatic range at the device bounds', () => {
    assert.deepEqual(constrainWave3AutomaticRange(21, 21), [19, 23]);
    assert.deepEqual(constrainWave3AutomaticRange(29, 30, 'lower'), [26, 30]);
    assert.deepEqual(constrainWave3AutomaticRange(16, 17, 'upper'), [16, 20]);
    assert.deepEqual(constrainWave3AutomaticRange(20, 24), [20, 24]);
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
        upperCelsius: 29,
      },
    });
    assert.deepEqual(planWave3TemperatureIntent({ mode: 'auto' }, {
      heatingCelsius: 20,
    }), { status: 'missingAutomaticRange' });
  });
});
