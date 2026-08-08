import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deviceTypes,
  type API,
  type Logging,
  type MatterAccessory,
  type MatterAPI,
  type PlatformConfig,
} from 'homebridge';

import {
  EcoFlowWave3Platform,
  type EcoFlowWave3PlatformDependencies,
  type PlatformCloudSession,
  type Wave3MatterAccessoryContext,
} from '../src/platform.js';
import type {
  Wave3AccessoryController,
} from '../src/wave3/controller.js';
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

  it('rejects a child bridge without Matter and explains the Matter-only setup', async () => {
    const harness = platformHarness(validConfig(), undefined, false);
    await harness.signalDidFinishLaunching();
    assert.equal(harness.sessionCreateCount, 0);
    assert.equal(harness.registered.length, 0);
    assert.match(
      harness.logs.error.join('\n'),
      /is Matter-only; enable Matter and disable HAP for this child bridge/,
    );
  });

  it('restores configured cache entries, prevents duplicates, registers missing devices, and removes stale entries', async () => {
    const harness = platformHarness(validConfig());
    const expectedFirstUuid = uuidFor('FIRST1234');
    const expectedSecondUuid = uuidFor('SECOND5678');
    const first = cachedMatterAccessory('Old Bedroom Name', expectedFirstUuid, 'FIRST1234');
    first.context.lastSystemMode = 0x04;
    const duplicate = cachedMatterAccessory('Duplicate', expectedFirstUuid, 'FIRST1234');
    const stale = cachedMatterAccessory('Old Unit', uuidFor('REMOVED9999'), 'REMOVED9999');
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
      schemaVersion: 5,
      serialNumber: 'FIRST1234',
      lastSystemMode: 0x04,
    });
    assert.equal(harness.updated.length, 0);
    assert.deepEqual(harness.boundSerials, ['FIRST1234', 'SECOND5678']);
    assert.deepEqual(harness.controllerFreshnessTimeouts, [300_000, 300_000]);
    assert.equal(harness.platform.matterAccessories.size, 2);
    assert.deepEqual(harness.fullDisplayStateRequests, ['FIRST1234', 'SECOND5678']);

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

  it('requests one full display snapshot only when cached state is absent or expired', async () => {
    const harness = platformHarness(validConfig());
    const recent = cachedMatterAccessory(
      'Bedroom WAVE 3',
      uuidFor('FIRST1234'),
      'FIRST1234',
    );
    recent.context.lastConfirmedAt = Date.now() - 60_000;
    harness.platform.configureMatterAccessory(recent);

    await harness.signalDidFinishLaunching();

    assert.deepEqual(harness.fullDisplayStateRequests, ['SECOND5678']);
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

  it('re-registers a cached Matter endpoint from a pre-electrical schema', async () => {
    const config = validConfig();
    config.devices = [{ name: 'Bedroom WAVE 3', serialNumber: 'FIRST1234' }];
    const harness = platformHarness(config);
    const cached = cachedMatterAccessory(
      'Bedroom WAVE 3',
      uuidFor('FIRST1234'),
      'FIRST1234',
    );
    (cached.context as { schemaVersion: number }).schemaVersion = 2;
    delete cached.clusters?.relativeHumidityMeasurement;
    harness.platform.configureMatterAccessory(cached);

    await harness.signalDidFinishLaunching();
    assert.deepEqual(harness.unregistered, [cached]);
    assert.equal(harness.registered.length, 1);
    assert.equal(harness.registered[0]?.context.schemaVersion, 5);
    assert.notEqual(harness.registered[0]?.clusters?.relativeHumidityMeasurement, undefined);
    assert.deepEqual(harness.registered[0]?.clusters?.electricalPowerMeasurement, {
      activePower: null,
    });
  });

  it('re-registers an older cached Matter endpoint before restoring the Auto feature shape', async () => {
    const harness = platformHarness(validConfig());
    const cached = cachedMatterAccessory(
      'Bedroom WAVE 3',
      uuidFor('FIRST1234'),
      'FIRST1234',
    );
    // Any older schema is replaced so Homebridge cannot restore cluster state
    // from the previous Heat/Cool-only endpoint shape onto the Auto endpoint.
    (cached.context as { schemaVersion: number }).schemaVersion = 4;
    harness.platform.configureMatterAccessory(cached);

    await harness.signalDidFinishLaunching();

    assert.deepEqual(harness.unregistered, [cached]);
    const replacement = harness.registered.find(accessory => accessory.UUID === cached.UUID);
    assert.equal(replacement?.context.schemaVersion, 5);
    assert.equal(replacement?.clusters?.thermostat?.systemMode, 0x03);
    assert.equal(replacement?.clusters?.thermostat?.minSetpointDeadBand, 0);
    assert.equal(
      (replacement?.deviceType.behaviors.thermostat as unknown as {
        features: { autoMode: boolean };
      }).features.autoMode,
      true,
    );
  });

  it('requires stable same-UUID removal before registering a changed endpoint shape', async () => {
    const config = validConfig();
    config.devices = [{ name: 'Bedroom WAVE 3', serialNumber: 'FIRST1234' }];
    const unregistrationGate = deferred();
    const harness = platformHarness(
      config,
      undefined,
      true,
      undefined,
      unregistrationGate,
      200,
      { transientUnregistrationMisses: 1 },
    );
    const cached = cachedMatterAccessory(
      'Bedroom WAVE 3',
      uuidFor('FIRST1234'),
      'FIRST1234',
    );
    (cached.context as { schemaVersion: number }).schemaVersion = 2;
    harness.platform.configureMatterAccessory(cached);

    const launch = harness.signalDidFinishLaunching();
    await waitUntil(() => harness.events.includes('unregister'));
    assert.deepEqual(harness.events, ['unregister']);

    // Homebridge can transiently report a missing state while its asynchronous
    // removal handler still owns the old endpoint. One miss must not release a
    // same-UUID replacement into that in-flight removal.
    await waitUntil(() => harness.stateReadClusters.length >= 2);
    assert.deepEqual(harness.events, ['unregister']);

    unregistrationGate.resolve();
    await launch;
    assert.deepEqual(harness.events, ['unregister', 'register', 'session:start']);
    assert.equal(harness.registered.length, 1);
  });

  it('requires stable readiness across every required Matter cluster', async () => {
    const config = validConfig();
    config.devices = [{ name: 'Bedroom WAVE 3', serialNumber: 'FIRST1234' }];
    const harness = platformHarness(
      config,
      undefined,
      true,
      undefined,
      undefined,
      20,
      { transientRegistrationReadMissAt: 4 },
    );

    await harness.signalDidFinishLaunching();

    assert.deepEqual(harness.stateReadClusters, [
      'onOff',
      'thermostat',
      'relativeHumidityMeasurement',
      'onOff',
      'onOff',
      'thermostat',
      'relativeHumidityMeasurement',
      'onOff',
      'thermostat',
      'relativeHumidityMeasurement',
    ]);
    assert.deepEqual(harness.events, ['register', 'session:start']);
  });

  it('makes shutdown terminal and joins launch work already in progress', async () => {
    const gate = deferred();
    const harness = platformHarness(validConfig(), gate);
    const launch = harness.signalDidFinishLaunching();
    await waitUntil(() => harness.events.includes('session:start'));
    assert.equal(harness.sessionCreateCount, 1);

    const shutdown = harness.platform.shutdown();
    await waitUntil(() => harness.sessionStopCount === 1);
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

  it('stops controllers before draining bindings with in-flight command work', async () => {
    const harness = platformHarness(
      validConfig(),
      undefined,
      true,
      undefined,
      undefined,
      200,
      { bindingStopWaitsForController: true },
    );
    await harness.signalDidFinishLaunching();
    await Promise.race([
      harness.platform.shutdown(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Shutdown did not stop controllers before bindings')), 100);
      }),
    ]);
    assert.equal(harness.controllerStopCount, 2);
    assert.equal(harness.bindingStopCount, 2);
    assert.equal(harness.sessionStopCount, 1);
    assert.deepEqual(
      harness.events.filter(event => /^(controller|binding):stop$/.test(event)),
      ['controller:stop', 'controller:stop', 'binding:stop', 'binding:stop'],
    );
  });

  it('fails closed and cleans partial resources after unexpected Matter setup failures', async () => {
    for (const options of [
      { failRegistrationAt: 2 },
      { failBindingAt: 2 },
    ]) {
      const harness = platformHarness(
        validConfig(),
        undefined,
        true,
        undefined,
        undefined,
        200,
        options,
      );
      await harness.signalDidFinishLaunching();
      assert.equal(harness.sessionCreateCount, 1);
      assert.equal(harness.sessionStopCount, 1);
      assert.doesNotMatch(harness.events.join(','), /session:start/);
      assert.equal(harness.controllerStopCount, 2);
      assert.equal(harness.bindingStopCount, 1);
      assert.equal(harness.platform.matterAccessories.size, 0);
      assert.equal(harness.unregistered.length, 2);
      assert.match(harness.logs.error.join('\n'), /Matter platform setup failed/);
      await harness.platform.shutdown();
      assert.equal(harness.sessionStopCount, 1);
    }
  });

  it('cleans resources created after shutdown begins during registration', async () => {
    const registrationGate = deferred();
    const harness = platformHarness(validConfig(), undefined, true, registrationGate);
    const launch = harness.signalDidFinishLaunching();
    await Promise.resolve();
    assert.deepEqual(harness.events, ['register']);
    await waitUntil(() => harness.stateReadClusters.length > 0);
    assert.deepEqual([...new Set(harness.stateReadClusters)], ['onOff']);

    const shutdown = harness.platform.shutdown();
    registrationGate.resolve();
    await Promise.all([launch, shutdown]);

    assert.equal(harness.sessionStopCount, 1);
    assert.equal(harness.controllerStopCount, 1);
    assert.equal(harness.bindingStopCount, 0);
    assert.doesNotMatch(harness.events.join(','), /session:start/);
    assert.deepEqual(harness.events, ['register', 'session:stop', 'unregister']);
    assert.equal(harness.unregistered.length, 1);
    assert.equal(harness.platform.matterAccessories.size, 0);
  });

  it('retries a dropped Matter registration after cleaning and settling its UUID', async () => {
    const harness = platformHarness(
      validConfig(),
      undefined,
      true,
      undefined,
      undefined,
      2,
      { dropRegistrationAt: 2 },
    );

    await harness.signalDidFinishLaunching();

    assert.equal(harness.sessionCreateCount, 1);
    assert.equal(harness.sessionStopCount, 0);
    assert.equal(harness.controllerStopCount, 0);
    assert.equal(harness.bindingStopCount, 0);
    assert.deepEqual(harness.events, [
      'register',
      'register',
      'unregister',
      'register',
      'session:start',
    ]);
    assert.equal(harness.platform.matterAccessories.size, 2);
    assert.match(harness.logs.warn.join('\n'), /Retrying Matter endpoint registration/);
  });

  it('cleans and retries a Matter endpoint that materializes after cancellation', async () => {
    const delayedRegistration = deferred();
    const config = validConfig();
    config.devices = [{ name: 'Bedroom WAVE 3', serialNumber: 'FIRST1234' }];
    const harness = platformHarness(
      config,
      undefined,
      true,
      delayedRegistration,
      undefined,
      4,
    );

    const launch = harness.signalDidFinishLaunching();
    await waitUntil(() => harness.events.includes('unregister'));
    delayedRegistration.resolve();
    await launch;

    assert.equal(harness.sessionStopCount, 0);
    assert.equal(harness.controllerStopCount, 0);
    assert.equal(harness.registered.length, 2);
    assert.equal(harness.unregistered.length, 2);
    assert.deepEqual(harness.events, [
      'register',
      'unregister',
      'unregister',
      'register',
      'session:start',
    ]);
    assert.equal(harness.platform.matterAccessories.size, 1);
  });

  it('fails closed after both bounded Matter registration attempts are dropped', async () => {
    const config = validConfig();
    config.devices = [{ name: 'Bedroom WAVE 3', serialNumber: 'FIRST1234' }];
    const harness = platformHarness(
      config,
      undefined,
      true,
      undefined,
      undefined,
      2,
      { dropRegistrationCalls: [1, 2] },
    );

    await harness.signalDidFinishLaunching();

    assert.equal(harness.sessionStopCount, 1);
    assert.equal(harness.controllerStopCount, 1);
    assert.doesNotMatch(harness.events.join(','), /session:start/);
    assert.deepEqual(harness.events, [
      'register',
      'unregister',
      'register',
      'unregister',
      'session:stop',
    ]);
    assert.equal(harness.platform.matterAccessories.size, 0);
    assert.match(harness.logs.error.join('\n'), /registration did not complete/);
  });

  it('bounds shutdown cleanup and fails closed on dropped Matter removal dispatches', async () => {
    const droppedRegistration = deferred();
    const registering = platformHarness(
      validConfig(),
      undefined,
      true,
      droppedRegistration,
      undefined,
      2,
    );
    const registeringLaunch = registering.signalDidFinishLaunching();
    await waitUntil(() => registering.events.includes('register'));
    assert.doesNotMatch(registering.events.join(','), /session:start/);
    await Promise.all([registeringLaunch, registering.platform.shutdown()]);
    assert.equal(registering.sessionStopCount, 1);
    assert.equal(registering.controllerStopCount, 1);
    assert.equal(registering.platform.matterAccessories.size, 0);
    assert.doesNotMatch(registering.logs.warn.join('\n'), /Retrying Matter endpoint registration/);

    const droppedUnregistration = deferred();
    const unregistering = platformHarness(
      validConfig(),
      undefined,
      true,
      undefined,
      droppedUnregistration,
      2,
    );
    unregistering.platform.configureMatterAccessory(cachedMatterAccessory(
      'Removed WAVE 3',
      uuidFor('REMOVED9999'),
      'REMOVED9999',
    ));
    await unregistering.signalDidFinishLaunching();
    await unregistering.platform.shutdown();
    assert.equal(unregistering.sessionCreateCount, 0);
    assert.match(unregistering.logs.error.join('\n'), /removal did not complete/);

    const config = validConfig();
    const droppedReplacement = deferred();
    const replacing = platformHarness(
      config,
      undefined,
      true,
      undefined,
      droppedReplacement,
      2,
    );
    const oldShape = cachedMatterAccessory(
      'Bedroom WAVE 3',
      uuidFor('FIRST1234'),
      'FIRST1234',
    );
    (oldShape.context as { schemaVersion: number }).schemaVersion = 2;
    replacing.platform.configureMatterAccessory(oldShape);
    await replacing.signalDidFinishLaunching();
    assert.equal(replacing.sessionCreateCount, 1);
    assert.equal(replacing.sessionStopCount, 1);
    assert.doesNotMatch(replacing.events.join(','), /session:start/);
    assert.equal(replacing.platform.matterAccessories.get(oldShape.UUID), oldShape);
    assert.equal(replacing.registered.length, 0);
    assert.equal(replacing.boundSerials.length, 0);
    assert.match(replacing.logs.error.join('\n'), /replacement could not remove the old shape/);
    await replacing.platform.shutdown();
    assert.equal(replacing.sessionStopCount, 1);
  });
});

function cachedMatterAccessory(
  displayName: string,
  UUID: string,
  serialNumber: string,
): MatterAccessory<Wave3MatterAccessoryContext> {
  return {
    UUID,
    displayName,
    serialNumber,
    manufacturer: 'EcoFlow',
    model: 'WAVE 3',
    deviceType: wave3RoomAirConditionerDeviceType({ deviceTypes } as unknown as MatterAPI),
    context: {
      schemaVersion: 5,
      serialNumber,
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
  registrationGate?: ReturnType<typeof deferred>,
  unregistrationGate?: ReturnType<typeof deferred>,
  matterOperationPollAttempts = 200,
  options: {
    bindingStopWaitsForController?: boolean;
    dropRegistrationCalls?: number[];
    failBindingAt?: number;
    dropRegistrationAt?: number;
    failRegistrationAt?: number;
    transientRegistrationReadMissAt?: number;
    transientUnregistrationMisses?: number;
  } = {},
): {
  platform: EcoFlowWave3Platform;
  registered: MatterAccessory[];
  updated: MatterAccessory[];
  unregistered: MatterAccessory[];
  boundSerials: string[];
  controllerFreshnessTimeouts: number[];
  fullDisplayStateRequests: string[];
  stateReadClusters: string[];
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
  const controllerFreshnessTimeouts: number[] = [];
  const fullDisplayStateRequests: string[] = [];
  const stateReadClusters: string[] = [];
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
  let bindingCreateCount = 0;
  let registrationCount = 0;
  let transientUnregistrationMisses = options.transientUnregistrationMisses ?? 0;
  const controllerStopped = deferred();
  const pendingUnregistrationUuids = new Set<string>();
  const registrationReadyUuids = new Set<string>();
  const unregisteredUuids = new Set<string>();
  const eventListeners = new Map<string, () => void>();

  const api = {
    matter: matterEnabled
      ? {
        deviceTypes,
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
          registrationCount += 1;
          if (registrationCount === options.failRegistrationAt) {
            throw new Error('synthetic Matter registration failure');
          }
          if (registrationCount === options.dropRegistrationAt
            || options.dropRegistrationCalls?.includes(registrationCount)) {
            return;
          }
          if (registrationGate === undefined) {
            registered.push(...accessories);
            for (const accessory of accessories) {
              unregisteredUuids.delete(accessory.UUID);
              registrationReadyUuids.add(accessory.UUID);
            }
          } else {
            void registrationGate.promise.then(() => {
              registered.push(...accessories);
              for (const accessory of accessories) {
                unregisteredUuids.delete(accessory.UUID);
                registrationReadyUuids.add(accessory.UUID);
              }
            });
          }
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
          for (const accessory of accessories) {
            pendingUnregistrationUuids.add(accessory.UUID);
          }
          const applyUnregistration = () => {
            unregistered.push(...accessories);
            for (const accessory of accessories) {
              pendingUnregistrationUuids.delete(accessory.UUID);
              registrationReadyUuids.delete(accessory.UUID);
              unregisteredUuids.add(accessory.UUID);
            }
          };
          if (unregistrationGate === undefined) {
            applyUnregistration();
          } else {
            void unregistrationGate.promise.then(applyUnregistration);
          }
        },
        updateAccessoryState: async () => undefined,
        getAccessoryState: async (uuid: string, cluster: string) => {
          stateReadClusters.push(cluster);
          if (registrationReadyUuids.has(uuid)
            && stateReadClusters.length === options.transientRegistrationReadMissAt) {
            return undefined;
          }
          if (pendingUnregistrationUuids.has(uuid) && transientUnregistrationMisses > 0) {
            transientUnregistrationMisses -= 1;
            return undefined;
          }
          const restoredCacheEntryIsReady = registrationGate === undefined
            && registrationCount === 0
            && !unregisteredUuids.has(uuid);
          return registrationReadyUuids.has(uuid) || restoredCacheEntryIsReady
            ? { onOff: false }
            : undefined;
        },
      }
      : undefined,
    isMatterEnabled: () => matterEnabled,
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
    matterRegistrationPollAttempts: matterOperationPollAttempts,
    matterOperationPollAttempts,
    matterRegistrationStablePolls: Math.min(2, matterOperationPollAttempts),
    matterUnregistrationStablePolls: Math.min(2, matterOperationPollAttempts),
    waitForMatterOperationPoll: async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    createSession: () => {
      sessionCreateCount += 1;
      return {
        state: 'idle',
        onMessage: () => () => undefined,
        onError: () => () => undefined,
        onStateChange: () => () => undefined,
        publishCommand: async () => undefined,
        requestState: async () => undefined,
        requestFullDisplayState: async serialNumber => {
          fullDisplayStateRequests.push(serialNumber);
        },
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
    createController: (serialNumber, _session, _logger, freshnessTimeoutMilliseconds) => {
      boundSerials.push(serialNumber);
      controllerFreshnessTimeouts.push(freshnessTimeoutMilliseconds);
      return {
        snapshot: {
          availability: 'offline',
          state: {},
          modeProfiles: {},
          runtimeTemperatures: {},
          runtimeTemperaturesFresh: false,
        } satisfies Wave3ControllerSnapshot,
        onSnapshot: () => () => undefined,
        execute: async () => ({
          status: 'failed',
          sequence: 10,
          reason: 'disconnected',
        }),
        stop: () => {
          controllerStopCount += 1;
          if (options.bindingStopWaitsForController) {
            events.push('controller:stop');
          }
          controllerStopped.resolve();
        },
      } satisfies Wave3AccessoryController;
    },
    bindMatterAccessory: () => {
      bindingCreateCount += 1;
      if (bindingCreateCount === options.failBindingAt) {
        throw new Error('synthetic Matter binding failure');
      }
      return {
        stop: async () => {
          bindingStopCount += 1;
          if (options.bindingStopWaitsForController) {
            events.push('binding:stop');
          }
          if (options.bindingStopWaitsForController && controllerStopCount === 0) {
            await controllerStopped.promise;
          }
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
    controllerFreshnessTimeouts,
    fullDisplayStateRequests,
    stateReadClusters,
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for test condition');
}
