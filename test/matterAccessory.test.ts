import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Endpoint, Environment, MockStorageService, ServerNode } from '@matter/main';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import type { MatterAccessory, MatterAPI } from 'homebridge';

import {
  createWave3MatterAccessory,
  MATTER_SYSTEM_MODE,
  wave3RoomAirConditionerDeviceType,
  Wave3MatterAccessory,
} from '../src/matterAccessory.js';
import type { Wave3AccessoryController } from '../src/platformAccessory.js';
import type { Wave3ControllerSnapshot } from '../src/wave3/domain.js';

describe('WAVE 3 Matter accessory', () => {
  it('constructs a conformant endpoint with the installed Matter runtime', async () => {
    const harness = matterHarness();
    const accessory = createWave3MatterAccessory(
      harness.matter,
      'matter-runtime-probe',
      device('ambient'),
      onlineSnapshot(),
    );
    const environment = new Environment('wave3-matter-accessory-test', Environment.default);
    new MockStorageService(environment);
    const node = await ServerNode.create({
      id: 'wave3-test-node',
      environment,
      network: { port: 0 },
      productDescription: { name: 'WAVE test', deviceType: 0x000e },
      basicInformation: {
        vendorName: 'Test',
        vendorId: 0xfff1,
        productName: 'WAVE test',
        productId: 0x8000,
        nodeLabel: 'WAVE test',
        serialNumber: 'wave3-test',
        hardwareVersion: 1,
        hardwareVersionString: '1',
        softwareVersion: 1,
        softwareVersionString: '1',
      },
    } as never);
    try {
      const aggregator = new Endpoint(AggregatorEndpoint, { id: 'wave3-test-aggregator' });
      await node.add(aggregator);
      const endpoint = new Endpoint(
        wave3RoomAirConditionerDeviceType('ambient').with(BridgedDeviceBasicInformationServer),
        {
          id: accessory.UUID,
          ...accessory.clusters,
          bridgedDeviceBasicInformation: {
            vendorName: 'EcoFlow',
            nodeLabel: accessory.displayName,
            productName: 'WAVE 3',
            productLabel: 'WAVE 3',
            serialNumber: 'redacted-test-serial',
            reachable: true,
          },
        } as never,
      );

      await aggregator.add(endpoint);
      const supported = endpoint.behaviors.supported as unknown as Record<
        string,
        { features: Record<string, boolean> }
      >;
      assert.equal(endpoint.lifecycle.isReady, true);
      assert.equal(supported.onOff?.features.deadFrontBehavior, true);
      assert.equal(supported.fanControl?.features.multiSpeed, true);
      await assert.rejects(
        async () => endpoint.act('reject unbound power command', agent => agent.onOff.on()),
        /unavailable until command mapping/,
      );
      await assert.rejects(
        endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.heat } }),
        /unavailable until command mapping/,
      );
      await assert.rejects(
        endpoint.set({ fanControl: { percentSetting: 80 } }),
        /unavailable until command mapping/,
      );
      assert.equal(endpoint.state.onOff.onOff, true);
      assert.equal(endpoint.state.thermostat.systemMode, MATTER_SYSTEM_MODE.auto);
      assert.equal(endpoint.state.fanControl.percentSetting, 60);
    } finally {
      await node.close();
    }
  });

  it('builds a customized room air conditioner with auto, fan, humidity, and complete state', () => {
    const harness = matterHarness();
    const accessory = createWave3MatterAccessory(
      harness.matter,
      'matter-uuid:first',
      device('ambient'),
      onlineSnapshot(),
    );

    const behaviors = accessory.deviceType.behaviors as Record<string, { features?: Record<string, boolean> }>;
    assert.deepEqual(behaviors.thermostat?.features, {
      heating: true,
      cooling: true,
      occupancy: false,
      setback: false,
      autoMode: true,
      localTemperatureNotExposed: false,
      matterScheduleConfiguration: false,
      presets: false,
      events: false,
      thermostatSuggestions: false,
    });
    assert.ok(behaviors.fanControl);
    assert.equal(behaviors.fanControl?.features?.multiSpeed, true);
    assert.ok(behaviors.relativeHumidityMeasurement);
    assert.equal(accessory.clusters?.onOff?.onOff, true);
    assert.deepEqual(accessory.clusters?.thermostat, {
      localTemperature: 2_123,
      occupiedCoolingSetpoint: 2_400,
      occupiedHeatingSetpoint: 1_900,
      controlSequenceOfOperation: 4,
      systemMode: MATTER_SYSTEM_MODE.auto,
      thermostatRunningMode: 0,
    });
    assert.deepEqual(accessory.clusters?.fanControl, {
      fanMode: 2,
      fanModeSequence: 0,
      percentSetting: 60,
      percentCurrent: 60,
      speedMax: 5,
      speedSetting: 3,
      speedCurrent: 3,
    });
    assert.deepEqual(accessory.clusters?.relativeHumidityMeasurement, {
      measuredValue: 5_456,
      minMeasuredValue: 0,
      maxMeasuredValue: 10_000,
    });
    assert.equal(accessory.firmwareRevision, '1.1.0.104');
    assert.equal(accessory.manufacturer, 'EcoFlow');
    assert.equal(accessory.model, 'WAVE 3');
    assert.equal(accessory.serialNumber, 'FIRST1234');
    assert.equal(accessory.handlers, undefined);
  });

  it('preserves the outlet and no-temperature endpoint contracts', () => {
    const harness = matterHarness();
    const outlet = createWave3MatterAccessory(
      harness.matter,
      'matter-uuid:outlet',
      device('outlet'),
      onlineSnapshot(),
    );
    assert.equal(outlet.clusters?.thermostat?.localTemperature, 1_655);
    assert.equal(outlet.clusters?.relativeHumidityMeasurement, undefined);
    assert.equal(
      (outlet.deviceType.behaviors.thermostat as unknown as { features: Record<string, boolean> }).features
        .localTemperatureNotExposed,
      false,
    );

    const none = createWave3MatterAccessory(
      harness.matter,
      'matter-uuid:none',
      device('none'),
      onlineSnapshot(),
    );
    assert.equal(none.clusters?.thermostat?.localTemperature, null);
    assert.equal(none.clusters?.relativeHumidityMeasurement, undefined);
    assert.equal(
      (none.deviceType.behaviors.thermostat as unknown as { features: Record<string, boolean> }).features
        .localTemperatureNotExposed,
      true,
    );

    const off = createWave3MatterAccessory(
      harness.matter,
      'matter-uuid:off',
      device('ambient'),
      offlineSnapshot(),
    );
    assert.deepEqual(off.clusters?.fanControl, {
      fanMode: 0,
      fanModeSequence: 0,
      percentSetting: 0,
      percentCurrent: 0,
      speedMax: 5,
      speedSetting: 0,
      speedCurrent: 0,
    });
  });

  it('updates external state and metadata only from controller snapshots', async () => {
    const harness = matterHarness();
    const controller = fakeController(offlineSnapshot());
    const accessory = createWave3MatterAccessory(
      harness.matter,
      'matter-uuid:first',
      device('ambient'),
      controller.snapshot,
    );
    const binding = new Wave3MatterAccessory(
      harness.matter,
      accessory,
      controller,
      'ambient',
    );

    assert.equal(harness.stateUpdates.length, 0);
    controller.emit(onlineSnapshot());
    await drainMicrotasks();
    assert.deepEqual(
      harness.stateUpdates.map(update => update.cluster),
      [
        'bridgedDeviceBasicInformation',
        'onOff',
        'thermostat',
        'fanControl',
        'relativeHumidityMeasurement',
      ],
    );
    assert.deepEqual(harness.stateUpdates[0]?.attributes, {
      softwareVersion: 16_842_856,
      softwareVersionString: '1.1.0.104',
    });
    assert.equal(harness.stateUpdates[1]?.attributes.onOff, true);
    assert.equal(harness.metadataUpdates.length, 0);

    controller.emit({
      ...onlineSnapshot(),
      availability: 'stale',
      state: { powered: false },
    });
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, 5);

    binding.stop();
    controller.emit(onlineSnapshot());
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, 5);
  });
});

function matterHarness(): {
  matter: MatterAPI;
  stateUpdates: Array<{ cluster: string; attributes: Record<string, unknown> }>;
  metadataUpdates: MatterAccessory[];
  } {
  const stateUpdates: Array<{ cluster: string; attributes: Record<string, unknown> }> = [];
  const metadataUpdates: MatterAccessory[] = [];
  const clusterState = new Map<string, Record<string, unknown>>([
    ['bridgedDeviceBasicInformation', {}],
  ]);
  return {
    matter: {
      clusterNames: {
        OnOff: 'onOff',
        Thermostat: 'thermostat',
        FanControl: 'fanControl',
        RelativeHumidityMeasurement: 'relativeHumidityMeasurement',
        BridgedDeviceBasicInformation: 'bridgedDeviceBasicInformation',
      },
      updateAccessoryState: async (
        _uuid: string,
        cluster: string,
        attributes: Record<string, unknown>,
      ) => {
        stateUpdates.push({ cluster, attributes });
        clusterState.set(cluster, { ...clusterState.get(cluster), ...attributes });
      },
      getAccessoryState: async (_uuid: string, cluster: string) => clusterState.get(cluster),
      updatePlatformAccessories: async (accessories: MatterAccessory[]) => {
        metadataUpdates.push(...accessories);
      },
    } as unknown as MatterAPI,
    stateUpdates,
    metadataUpdates,
  };
}

function fakeController(initial: Wave3ControllerSnapshot): Wave3AccessoryController & {
  emit(snapshot: Wave3ControllerSnapshot): void;
} {
  let listener: ((snapshot: Wave3ControllerSnapshot) => void) | undefined;
  return {
    snapshot: initial,
    onSnapshot: value => {
      listener = value;
      return () => {
        listener = undefined;
      };
    },
    execute: async () => ({ status: 'failed', sequence: 1, reason: 'disconnected' }),
    stop: () => undefined,
    emit: snapshot => listener?.(snapshot),
  };
}

function device(currentTemperatureSource: 'ambient' | 'outlet' | 'none') {
  return {
    name: 'Bedroom WAVE 3',
    serialNumber: 'FIRST1234',
    currentTemperatureSource,
  } as const;
}

function offlineSnapshot(): Wave3ControllerSnapshot {
  return {
    availability: 'offline',
    state: {},
    runtimeTemperatures: {},
  };
}

function onlineSnapshot(): Wave3ControllerSnapshot {
  return {
    availability: 'online',
    state: {
      powered: true,
      mode: 'auto',
      ambientTemperatureCelsius: 21.23,
      outletTemperatureCelsius: 16.55,
      ambientHumidityPercent: 54.56,
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
      airflowSpeed: 60,
    },
    runtimeTemperatures: {},
    firmwareVersions: { pd: '1.1.0.104' },
    updatedAt: 1,
  };
}

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
