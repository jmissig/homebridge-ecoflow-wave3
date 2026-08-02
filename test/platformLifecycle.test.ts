import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  API,
  Logging,
  MatterAccessory,
  PlatformConfig,
} from 'homebridge';

import {
  EcoFlowWave3Platform,
  type EcoFlowWave3PlatformDependencies,
  type PlatformCloudSession,
  type Wave3MatterAccessoryContext,
} from '../src/platform.js';
import type {
  Wave3AccessoryController,
} from '../src/platformAccessory.js';
import { wave3RoomAirConditionerDeviceType } from '../src/matterAccessory.js';
import type { Wave3ControllerSnapshot } from '../src/wave3/domain.js';

describe('EcoFlow WAVE 3 platform lifecycle', () => {
  it('validates configuration before creating a session', async () => {
    const harness = platformHarness({
      name: 'Invalid',
      platform: 'EcoFlowWave3',
    });
    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 0);
    assert.equal(harness.registered.length, 0);
    assert.match(harness.logs.error.join('\n'), /configuration is invalid/);
  });

  it('requires Matter before starting account or device sessions', async () => {
    const harness = platformHarness(validConfig(), undefined, false);
    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 0);
    assert.equal(harness.registered.length, 0);
    assert.match(harness.logs.error.join('\n'), /requires Matter.*HAP fallback is not supported/);
  });

  it('restores configured cache entries, prevents duplicates, registers missing devices, and removes stale entries', async () => {
    const harness = platformHarness(validConfig());
    const expectedFirstUuid = uuidFor('FIRST1234');
    const expectedSecondUuid = uuidFor('SECOND5678');
    const first = cachedMatterAccessory('Old Bedroom Name', expectedFirstUuid, 'FIRST1234', 'ambient');
    first.context.lastSystemMode = 0x04;
    const duplicate = cachedMatterAccessory('Duplicate', expectedFirstUuid, 'FIRST1234', 'ambient');
    const stale = cachedMatterAccessory('Old Unit', uuidFor('REMOVED9999'), 'REMOVED9999', 'ambient');
    harness.platform.configureMatterAccessory(first);
    harness.platform.configureMatterAccessory(duplicate);
    harness.platform.configureMatterAccessory(stale);

    assert.equal(harness.sessionCreateCount, 0);
    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 1);
    assert.deepEqual(harness.events.slice(-1), ['session:start']);
    assert.deepEqual(harness.unregistered, [duplicate, stale]);
    assert.equal(harness.registered.length, 2);
    assert.deepEqual(
      harness.registered.map(accessory => accessory.UUID),
      [expectedFirstUuid, expectedSecondUuid],
    );
    const restored = harness.platform.matterAccessories.get(expectedFirstUuid)!;
    assert.equal(restored.displayName, 'Bedroom WAVE 3');
    assert.deepEqual(restored.context, {
      schemaVersion: 1,
      serialNumber: 'FIRST1234',
      currentTemperatureSource: 'ambient',
      lastSystemMode: 0x04,
    });
    assert.equal(harness.updated.length, 0);
    assert.deepEqual(harness.boundSerials, ['FIRST1234', 'SECOND5678']);
    assert.deepEqual(harness.boundTemperatureSources, ['ambient', 'none']);
    assert.equal(harness.platform.matterAccessories.size, 2);

    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 1);
    assert.equal(harness.registered.length, 2);

    await Promise.all([
      harness.platform.shutdown(),
      harness.platform.shutdown(),
    ]);
    assert.equal(harness.sessionStopCount, 1);
    assert.equal(harness.bindingStopCount, 2);
    assert.equal(harness.controllerStopCount, 2);
  });

  it('uses stable serial-derived UUIDs without writing identifiers to logs', async () => {
    const first = platformHarness(validConfig());
    const second = platformHarness(validConfig());
    await first.signalDidFinishLaunching();
    await second.signalDidFinishLaunching();
    assert.deepEqual(
      first.registered.map(accessory => accessory.UUID),
      second.registered.map(accessory => accessory.UUID),
    );
    const logs = Object.values(first.logs).flat().join('\n');
    assert.doesNotMatch(logs, /FIRST1234|SECOND5678/);
    assert.doesNotMatch(logs, /token|password|authorization/i);
  });

  it('re-registers a cached Matter endpoint when its temperature-source shape changes', async () => {
    const config = validConfig();
    config.devices = [{
      name: 'Bedroom WAVE 3',
      serialNumber: 'FIRST1234',
      currentTemperatureSource: 'outlet',
    }];
    const harness = platformHarness(config);
    const cached = cachedMatterAccessory(
      'Bedroom WAVE 3',
      uuidFor('FIRST1234'),
      'FIRST1234',
      'ambient',
    );
    harness.platform.configureMatterAccessory(cached);

    await harness.signalDidFinishLaunching();
    assert.deepEqual(harness.unregistered, [cached]);
    assert.equal(harness.registered.length, 1);
    assert.equal(
      harness.registered[0]?.context.currentTemperatureSource,
      'outlet',
    );
    assert.equal(
      harness.registered[0]?.clusters?.relativeHumidityMeasurement,
      undefined,
    );
  });

  it('makes shutdown terminal and joins launch work already in progress', async () => {
    const gate = deferred();
    const harness = platformHarness(validConfig(), gate);
    const launch = harness.signalDidFinishLaunching();
    await Promise.resolve();
    assert.equal(harness.sessionCreateCount, 1);

    const shutdown = harness.platform.shutdown();
    assert.equal(harness.sessionStopCount, 1);
    gate.resolve();
    await Promise.all([launch, shutdown]);
    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 1);
    assert.equal(harness.sessionStopCount, 1);

    const stoppedBeforeLaunch = platformHarness(validConfig());
    await stoppedBeforeLaunch.platform.shutdown();
    await stoppedBeforeLaunch.signalDidFinishLaunching();
    assert.equal(stoppedBeforeLaunch.sessionCreateCount, 0);
  });
});

class FakeCachedAccessory {
  context: Record<string, unknown> = {};

  constructor(
    public displayName: string,
    public readonly UUID: string,
  ) {}

  updateDisplayName(name: string): void {
    this.displayName = name;
  }
}

function cachedMatterAccessory(
  displayName: string,
  UUID: string,
  serialNumber: string,
  currentTemperatureSource: 'ambient' | 'outlet' | 'none',
): MatterAccessory<Wave3MatterAccessoryContext> {
  return {
    UUID,
    displayName,
    serialNumber,
    manufacturer: 'EcoFlow',
    model: 'WAVE 3',
    deviceType: wave3RoomAirConditionerDeviceType(currentTemperatureSource),
    context: {
      schemaVersion: 1,
      serialNumber,
      currentTemperatureSource,
    },
    clusters: {
      onOff: { onOff: false },
      thermostat: { systemMode: 0x03 },
      fanControl: { percentSetting: 20 },
    },
  };
}

function platformHarness(
  config: PlatformConfig,
  startGate?: ReturnType<typeof deferred>,
  matterEnabled = true,
): {
  platform: EcoFlowWave3Platform;
  registered: MatterAccessory[];
  updated: MatterAccessory[];
  unregistered: MatterAccessory[];
  boundSerials: string[];
  boundTemperatureSources: string[];
  events: string[];
  logs: Record<'debug' | 'info' | 'warn' | 'error', string[]>;
  signalDidFinishLaunching(): Promise<void>;
  readonly sessionCreateCount: number;
  readonly sessionStopCount: number;
  readonly bindingStopCount: number;
  readonly controllerStopCount: number;
} {
  const registered: MatterAccessory[] = [];
  const updated: MatterAccessory[] = [];
  const unregistered: MatterAccessory[] = [];
  const boundSerials: string[] = [];
  const boundTemperatureSources: string[] = [];
  const events: string[] = [];
  const logs = {
    debug: [] as string[],
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  };
  let sessionCreateCount = 0;
  let sessionStopCount = 0;
  let bindingStopCount = 0;
  let controllerStopCount = 0;
  const eventListeners = new Map<string, () => void>();

  class Accessory extends FakeCachedAccessory {}
  const api = {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: {
        generate: () => {
          throw new Error('HAP UUID generator must not be used');
        },
      },
    },
    platformAccessory: Accessory,
    matter: matterEnabled
      ? {
        uuid: {
          generate: matterUuidForSeed,
        },
        clusterNames: {
          OnOff: 'onOff',
          Thermostat: 'thermostat',
          FanControl: 'fanControl',
          RelativeHumidityMeasurement: 'relativeHumidityMeasurement',
        },
        registerPlatformAccessories: async (
          _plugin: string,
          _platform: string,
          accessories: MatterAccessory[],
        ) => {
          events.push('register');
          registered.push(...accessories);
        },
        updatePlatformAccessories: async (accessories: MatterAccessory[]) => {
          events.push('update');
          updated.push(...accessories);
        },
        unregisterPlatformAccessories: async (
          _plugin: string,
          _platform: string,
          accessories: MatterAccessory[],
        ) => {
          events.push('unregister');
          unregistered.push(...accessories);
        },
        updateAccessoryState: async () => undefined,
      }
      : undefined,
    isMatterEnabled: () => matterEnabled,
    registerPlatformAccessories: () => {
      throw new Error('HAP registration must not be used');
    },
    updatePlatformAccessories: () => {
      throw new Error('HAP update must not be used');
    },
    unregisterPlatformAccessories: () => {
      throw new Error('HAP unregistration must not be used');
    },
    on: (event: string, listener: () => void) => {
      eventListeners.set(event, listener);
      return api;
    },
  };
  const logger = {
    debug: (message: string) => logs.debug.push(message),
    info: (message: string) => logs.info.push(message),
    warn: (message: string) => logs.warn.push(message),
    error: (message: string) => logs.error.push(message),
  };
  const dependencies: EcoFlowWave3PlatformDependencies = {
    createSession: () => {
      sessionCreateCount += 1;
      return {
        state: 'idle',
        onMessage: () => () => undefined,
        onError: () => () => undefined,
        onStateChange: () => () => undefined,
        publishCommand: async () => undefined,
        requestState: async () => undefined,
        start: async () => {
          events.push('session:start');
          await startGate?.promise;
        },
        stop: async () => {
          sessionStopCount += 1;
          events.push('session:stop');
        },
      } satisfies PlatformCloudSession;
    },
    createController: serialNumber => {
      boundSerials.push(serialNumber);
      return {
        snapshot: {
          availability: 'offline',
          state: {},
          runtimeTemperatures: {},
        } satisfies Wave3ControllerSnapshot,
        onSnapshot: () => () => undefined,
        execute: async () => ({
          status: 'failed',
          sequence: 10,
          reason: 'disconnected',
        }),
        stop: () => {
          controllerStopCount += 1;
        },
      } satisfies Wave3AccessoryController;
    },
    bindMatterAccessory: (_matter, _accessory, _controller, device) => {
      boundTemperatureSources.push(device.currentTemperatureSource);
      return {
        stop: () => {
          bindingStopCount += 1;
        },
      };
    },
  };
  const platform = new EcoFlowWave3Platform(
    logger as unknown as Logging,
    config,
    api as unknown as API,
    dependencies,
  );

  return {
    platform,
    registered,
    updated,
    unregistered,
    boundSerials,
    boundTemperatureSources,
    events,
    logs,
    async signalDidFinishLaunching() {
      eventListeners.get('didFinishLaunching')?.();
      await platform.launch();
    },
    get sessionCreateCount() {
      return sessionCreateCount;
    },
    get sessionStopCount() {
      return sessionStopCount;
    },
    get bindingStopCount() {
      return bindingStopCount;
    },
    get controllerStopCount() {
      return controllerStopCount;
    },
  };
}

function validConfig(): PlatformConfig {
  return {
    platform: 'EcoFlowWave3',
    name: 'EcoFlow WAVE 3',
    email: 'person@example.com',
    password: 'secret',
    apiHost: 'api-a.ecoflow.com',
    devices: [
      { name: 'Bedroom WAVE 3', serialNumber: 'FIRST1234' },
      {
        name: 'Office WAVE 3',
        serialNumber: 'SECOND5678',
        currentTemperatureSource: 'none',
      },
    ],
  };
}

function uuidFor(serialNumber: string): string {
  return matterUuidForSeed(`homebridge-ecoflow-wave3:wave3:${serialNumber}`);
}

function matterUuidForSeed(seed: string): string {
  return `matter-uuid:${seed}`;
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
