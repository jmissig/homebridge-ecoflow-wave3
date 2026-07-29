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

  it('aligns syntactic validation and documents runtime-only serial uniqueness', () => {
    const schemaDocument = JSON.parse(readFileSync(
      new URL('../config.schema.json', import.meta.url),
      'utf8',
    )) as { schema: object };
    const ajv = new Ajv({ allErrors: true });
    ajv.addFormat('email', /^[^\s@]+@[^\s@]+$/);
    ajv.addFormat('password', true);
    const validateSchema = ajv.compile(schemaDocument.schema);
    const cases: Array<{
      candidate: Record<string, unknown>;
      schemaAccepted: boolean;
      runtimeAccepted: boolean;
    }> = [
      { candidate: baseConfig(), schemaAccepted: true, runtimeAccepted: true },
      {
        candidate: baseConfig({ password: '   ' }),
        schemaAccepted: true,
        runtimeAccepted: true,
      },
      {
        candidate: baseConfig({ email: 'a@' }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({ name: '   ' }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({ name: 'Line one\nLine two' }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({
          devices: [{ name: 'Bedroom', serialNumber: ' TESTWAVE30001 ' }],
        }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({
          advancedApiHostOverride: `${'a'.repeat(250)}.test`,
        }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({
          apiHost: 'not-ecoflow.example',
          advancedApiHostOverride: 'private-api.example.test',
        }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({
          devices: [
            { name: 'Bedroom', serialNumber: 'TESTWAVE30001' },
            { name: 'Office', serialNumber: 'TESTWAVE30001' },
          ],
        }),
        // JSON Schema can reject byte-for-byte duplicate items but cannot
        // express uniqueness of one property across otherwise distinct items.
        schemaAccepted: true,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({ advancedApiHostOverride: '.' }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({ advancedApiHostOverride: '127.1' }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({ advancedApiHostOverride: '127.0.0.1' }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
      {
        candidate: baseConfig({ unknownField: true }),
        schemaAccepted: false,
        runtimeAccepted: false,
      },
    ];

    for (const { candidate, schemaAccepted, runtimeAccepted } of cases) {
      const schemaCandidate = { ...candidate };
      // Homebridge owns the platform discriminator and validates only the
      // plugin-specific object against config.schema.json.
      delete schemaCandidate.platform;
      assert.equal(validateSchema(schemaCandidate), schemaAccepted);
      assert.equal(runtimeAccepts(candidate), runtimeAccepted);
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
