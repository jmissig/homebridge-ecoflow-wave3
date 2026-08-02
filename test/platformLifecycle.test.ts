import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  API,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import {
  EcoFlowWave3Platform,
  type EcoFlowWave3PlatformDependencies,
  type PlatformCloudSession,
} from '../src/platform.js';
import type {
  Wave3AccessoryController,
  Wave3PlatformAccessory,
} from '../src/platformAccessory.js';
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
    const first = new FakeCachedAccessory('Old Bedroom Name', expectedFirstUuid);
    first.context.lastTargetMode = 'heat';
    const duplicate = new FakeCachedAccessory('Duplicate', expectedFirstUuid);
    const stale = new FakeCachedAccessory('Old Unit', uuidFor('REMOVED9999'));
    harness.platform.configureAccessory(first as unknown as PlatformAccessory);
    harness.platform.configureAccessory(duplicate as unknown as PlatformAccessory);
    harness.platform.configureAccessory(stale as unknown as PlatformAccessory);

    assert.equal(harness.sessionCreateCount, 0);
    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 1);
    assert.deepEqual(harness.events.slice(-1), ['session:start']);
    assert.deepEqual(harness.unregistered, [duplicate, stale]);
    assert.equal(harness.registered.length, 1);
    assert.equal(harness.registered[0]?.UUID, expectedSecondUuid);
    assert.equal(first.displayName, 'Bedroom WAVE 3');
    assert.deepEqual(first.context, {
      schemaVersion: 1,
      serialNumber: 'FIRST1234',
      lastTargetMode: 'heat',
    });
    assert.equal(harness.updated.length, 2);
    assert.deepEqual(harness.boundSerials, ['FIRST1234', 'SECOND5678']);
    assert.deepEqual(harness.boundTemperatureSources, ['ambient', 'none']);
    assert.equal(harness.platform.accessories.size, 2);

    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 1);
    assert.equal(harness.registered.length, 1);

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

function platformHarness(
  config: PlatformConfig,
  startGate?: ReturnType<typeof deferred>,
  matterEnabled = true,
): {
  platform: EcoFlowWave3Platform;
  registered: FakeCachedAccessory[];
  updated: FakeCachedAccessory[];
  unregistered: FakeCachedAccessory[];
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
  const registered: FakeCachedAccessory[] = [];
  const updated: FakeCachedAccessory[] = [];
  const unregistered: FakeCachedAccessory[] = [];
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
        generate: uuidForSeed,
      },
    },
    platformAccessory: Accessory,
    matter: matterEnabled
      ? {
        uuid: {
          generate: uuidForSeed,
        },
      }
      : undefined,
    isMatterEnabled: () => matterEnabled,
    registerPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: FakeCachedAccessory[],
    ) => {
      events.push('register');
      registered.push(...accessories);
    },
    updatePlatformAccessories: (accessories: FakeCachedAccessory[]) => {
      events.push('update');
      updated.push(...accessories);
    },
    unregisterPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: FakeCachedAccessory[],
    ) => {
      events.push('unregister');
      unregistered.push(...accessories);
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
    bindAccessory: (_platform, _accessory, _controller, device) => {
      boundTemperatureSources.push(device.currentTemperatureSource);
      return {
        stop: () => {
          bindingStopCount += 1;
        },
      } as Wave3PlatformAccessory;
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
  return uuidForSeed(`homebridge-ecoflow-wave3:wave3:${serialNumber}`);
}

function uuidForSeed(seed: string): string {
  return `uuid:${seed}`;
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
