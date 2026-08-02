import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  registerMatterControl,
  releaseMatterControlState,
  rememberDesiredCluster,
  requireDesiredValueOrControl,
  type Wave3MatterControl,
} from '../src/matter/controlRegistry.js';

describe('Matter control registry', () => {
  it('consumes expected internal writes without dispatching them as user control', () => {
    const uuid = 'expected-write';
    let dispatched = false;
    registerMatterControl(uuid, fakeControl());
    try {
      rememberDesiredCluster(uuid, 'thermostat', { systemMode: 3 });
      assert.equal(requireDesiredValueOrControl(
        uuid,
        'thermostat',
        'systemMode',
        3,
        () => {
          dispatched = true;
        },
      ), false);
      assert.equal(dispatched, false);
    } finally {
      releaseMatterControlState(uuid);
    }
  });

  it('rejects duplicate controls and clears control and desired state on release', () => {
    const uuid = 'release-cleanup';
    registerMatterControl(uuid, fakeControl());
    rememberDesiredCluster(uuid, 'thermostat', { systemMode: 3 });
    assert.throws(
      () => registerMatterControl(uuid, fakeControl()),
      /already registered/,
    );

    releaseMatterControlState(uuid);

    assert.throws(
      () => requireDesiredValueOrControl(
        uuid,
        'thermostat',
        'systemMode',
        3,
        () => undefined,
      ),
      /unavailable/,
    );
  });
});

function fakeControl(): Wave3MatterControl {
  return {
    setPower: async () => undefined,
    setSystemMode: () => undefined,
    setHeatingSetpoint: () => undefined,
    setCoolingSetpoint: () => undefined,
    raiseLowerSetpoint: async () => undefined,
    setFanMode: () => undefined,
    setFanPercent: () => undefined,
    setFanSpeed: () => undefined,
  };
}
