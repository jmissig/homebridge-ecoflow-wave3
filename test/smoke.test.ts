import assert from 'node:assert/strict';
import test from 'node:test';

import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

test('the TypeScript test harness loads the ESM plugin settings', () => {
  assert.equal(PLUGIN_NAME, 'homebridge-ecoflow-wave3');
  assert.equal(PLATFORM_NAME, 'EcoFlowWave3');
});
