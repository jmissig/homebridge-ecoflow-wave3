import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Ajv } from 'ajv/dist/ajv.js';

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

  it('keeps runtime acceptance aligned with the published schema', () => {
    const schemaDocument = JSON.parse(readFileSync(
      new URL('../config.schema.json', import.meta.url),
      'utf8',
    )) as { schema: object };
    const ajv = new Ajv({ allErrors: true });
    ajv.addFormat('email', /^[^\s@]+@[^\s@]+$/);
    ajv.addFormat('password', true);
    const validateSchema = ajv.compile(schemaDocument.schema);
    const cases: Array<{ candidate: Record<string, unknown>; accepted: boolean }> = [
      { candidate: baseConfig(), accepted: true },
      { candidate: baseConfig({ email: 'a@' }), accepted: false },
      { candidate: baseConfig({ name: '   ' }), accepted: false },
      { candidate: baseConfig({ name: 'Line one\nLine two' }), accepted: false },
      {
        candidate: baseConfig({
          devices: [{ name: 'Bedroom', serialNumber: ' TESTWAVE30001 ' }],
        }),
        accepted: false,
      },
      {
        candidate: baseConfig({
          advancedApiHostOverride: `${'a'.repeat(250)}.test`,
        }),
        accepted: false,
      },
      { candidate: baseConfig({ advancedApiHostOverride: '.' }), accepted: false },
      { candidate: baseConfig({ unknownField: true }), accepted: false },
    ];

    for (const { candidate, accepted } of cases) {
      const schemaCandidate = { ...candidate };
      // Homebridge owns the platform discriminator and validates only the
      // plugin-specific object against config.schema.json.
      delete schemaCandidate.platform;
      assert.equal(validateSchema(schemaCandidate), accepted);
      assert.equal(runtimeAccepts(candidate), accepted);
    }
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

function runtimeAccepts(candidate: Record<string, unknown>): boolean {
  try {
    parseEcoFlowWave3Config(candidate);
    return true;
  } catch {
    return false;
  }
}
