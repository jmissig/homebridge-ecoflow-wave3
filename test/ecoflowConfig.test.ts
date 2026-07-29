import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigurationError,
  parseEcoFlowWave3Config,
} from '../src/ecoflow/config.js';

describe('EcoFlow WAVE 3 configuration', () => {
  it('accepts explicit WAVE 3 units on reviewed regional hosts', () => {
    const config = parseEcoFlowWave3Config({
      platform: 'EcoFlowWave3',
      name: 'House WAVE units',
      email: 'owner@example.test',
      password: 'not-a-real-password',
      apiHost: 'api-a.ecoflow.com',
      devices: [
        { name: 'Bedroom', serialNumber: 'TESTWAVE30001' },
        { name: 'Office', serialNumber: 'TESTWAVE30002' },
      ],
    });

    assert.equal(config.apiHost, 'api-a.ecoflow.com');
    assert.equal(config.devices.length, 2);
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.devices), true);
  });

  it('requires a valid, unique explicit serial for every configured unit', () => {
    assert.throws(
      () => parseEcoFlowWave3Config(baseConfig({ devices: [] })),
      /at least one/,
    );
    assert.throws(
      () => parseEcoFlowWave3Config(baseConfig({
        devices: [{ name: 'Bedroom' }],
      })),
      /serialNumber/,
    );
    assert.throws(
      () => parseEcoFlowWave3Config(baseConfig({
        devices: [{ name: 'Bedroom', serialNumber: 'bad/topic' }],
      })),
      /invalid format/,
    );
    assert.throws(
      () => parseEcoFlowWave3Config(baseConfig({
        devices: [
          { name: 'Bedroom', serialNumber: 'TESTWAVE30001' },
          { name: 'Office', serialNumber: 'TESTWAVE30001' },
        ],
      })),
      /duplicated/,
    );
  });

  it('rejects unreviewed hosts unless the advanced override is explicit', () => {
    assert.throws(
      () => parseEcoFlowWave3Config(baseConfig({ apiHost: 'not-ecoflow.example' })),
      ConfigurationError,
    );

    const overridden = parseEcoFlowWave3Config(baseConfig({
      advancedApiHostOverride: 'private-api.example.test',
    }));
    assert.equal(overridden.apiHost, 'private-api.example.test');

    assert.throws(
      () => parseEcoFlowWave3Config(baseConfig({
        advancedApiHostOverride: 'https://private-api.example.test/path',
      })),
      /hostname/,
    );
  });
});

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'EcoFlow WAVE 3',
    email: 'owner@example.test',
    password: 'not-a-real-password',
    apiHost: 'api.ecoflow.com',
    devices: [{ name: 'Bedroom', serialNumber: 'TESTWAVE30001' }],
    ...overrides,
  };
}
