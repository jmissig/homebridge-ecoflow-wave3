import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Endpoint, Environment, MockStorageService, ServerNode } from '@matter/main';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { deviceTypes, MatterStatus, type MatterAccessory, type MatterAPI } from 'homebridge';

import {
  createWave3MatterAccessory,
  MATTER_SYSTEM_MODE,
  wave3RoomAirConditionerDeviceType,
  Wave3MatterAccessory,
} from '../src/matterAccessory.js';
import { MATTER_TEMPERATURE_DISPLAY_MODE } from '../src/matter/constants.js';
import type { Wave3AccessoryController } from '../src/wave3/controller.js';
import type {
  Wave3Command,
  Wave3CommandFailure,
  Wave3ControllerSnapshot,
} from '../src/wave3/domain.js';

describe('WAVE 3 Matter accessory', () => {
  it('maps advertised system modes and degrades external Auto to cooling presentation', () => {
    const harness = matterHarness();
    const cases = [
      { mode: 'off', powered: false, submode: 0, speed: 20, systemMode: 3, fanMode: 0 },
      { mode: 'auto', powered: true, submode: 0, speed: 20, systemMode: 3, fanMode: 1 },
      { mode: 'cool', powered: true, submode: 0, speed: 40, systemMode: 3, fanMode: 2 },
      { mode: 'heat', powered: true, submode: 0, speed: 60, systemMode: 4, fanMode: 2 },
      { mode: 'fan', powered: true, submode: 0, speed: 80, systemMode: 7, fanMode: 3 },
      { mode: 'dry', powered: true, submode: 0, speed: 100, systemMode: 8, fanMode: 3 },
      { mode: 'cool', powered: true, submode: 3, speed: 20, systemMode: 9, fanMode: 1 },
    ] as const;

    for (const [index, value] of cases.entries()) {
      const snapshot: Wave3ControllerSnapshot = {
        availability: 'online',
        state: {
          powered: value.powered,
          mode: value.mode,
          submode: value.submode,
          airflowSpeed: value.speed,
          ambientTemperatureCelsius: 21,
          ambientHumidityPercent: 50,
          ...(value.mode === 'auto'
            ? {
              targetTemperatureLowerCelsius: 19,
              targetTemperatureUpperCelsius: 24,
            }
            : value.mode === 'cool' || value.mode === 'heat'
              ? { targetTemperatureCelsius: 22 }
              : {}),
        },
        modeProfiles: {},
        runtimeTemperatures: {},
      };
      const accessory = createWave3MatterAccessory(
        harness.matter,
        `matter-mode-${index}`,
        device('ambient'),
        snapshot,
      );
      assert.equal(accessory.clusters?.onOff?.onOff, value.powered);
      assert.equal(accessory.clusters?.thermostat?.systemMode, value.systemMode);
      assert.equal(accessory.clusters?.thermostat?.thermostatRunningMode, undefined);
      assert.equal(accessory.clusters?.fanControl?.fanMode, value.fanMode);
      assert.equal(accessory.clusters?.fanControl?.percentSetting, value.powered ? value.speed : 0);
      assert.equal(accessory.clusters?.fanControl?.speedSetting, value.powered ? value.speed / 20 : 0);
    }
  });

  it('projects only the confirmed active manual profile without rewriting saved profiles', () => {
    const harness = matterHarness();
    const profiles = {
      cool: { targetTemperatureCelsius: 22, airflowSpeed: 20 as const },
      heat: { targetTemperatureCelsius: 25.5, airflowSpeed: 40 as const },
    };
    const cool = createWave3MatterAccessory(
      harness.matter,
      'matter-profile-sync-cool',
      device('ambient'),
      {
        availability: 'online',
        state: { powered: true, mode: 'cool', targetTemperatureCelsius: 22 },
        modeProfiles: profiles,
        runtimeTemperatures: {},
      },
    );
    assert.equal(cool.clusters?.thermostat?.occupiedCoolingSetpoint, 2_200);
    assert.equal(cool.clusters?.thermostat?.occupiedHeatingSetpoint, 2_200);

    const heat = createWave3MatterAccessory(
      harness.matter,
      'matter-profile-sync-heat',
      device('ambient'),
      {
        availability: 'online',
        state: { powered: true, mode: 'heat', targetTemperatureCelsius: 25.5 },
        modeProfiles: profiles,
        runtimeTemperatures: {},
      },
    );
    assert.equal(heat.clusters?.thermostat?.occupiedCoolingSetpoint, 2_550);
    assert.equal(heat.clusters?.thermostat?.occupiedHeatingSetpoint, 2_550);
    assert.deepEqual(profiles, {
      cool: { targetTemperatureCelsius: 22, airflowSpeed: 20 },
      heat: { targetTemperatureCelsius: 25.5, airflowSpeed: 40 },
    });
  });

  it('preserves cached control state and complete endpoint shape for every temperature source', () => {
    const harness = matterHarness();
    const partial: Wave3ControllerSnapshot = {
      availability: 'online',
      state: { ambientHumidityPercent: 61 },
      modeProfiles: {},
      runtimeTemperatures: {},
    };

    for (const source of ['ambient', 'outlet', 'none'] as const) {
      const cached = createWave3MatterAccessory(
        harness.matter,
        `matter-partial-cache-${source}`,
        device(source),
        onlineSnapshot(),
      );
      // Exercise migration from a cache written while Auto was advertised.
      cached.context.lastSystemMode = MATTER_SYSTEM_MODE.auto;
      cached.clusters!.thermostat!.minSetpointDeadBand = 0;
      const restored = createWave3MatterAccessory(
        harness.matter,
        cached.UUID,
        device(source),
        partial,
        cached,
      );
      assert.equal(restored.clusters?.onOff?.onOff, true);
      assert.equal(restored.clusters?.thermostat?.systemMode, MATTER_SYSTEM_MODE.cool);
      assert.equal(restored.clusters?.thermostat?.minSetpointDeadBand, undefined);
      assert.equal(restored.clusters?.thermostat?.occupiedHeatingSetpoint, 1_900);
      assert.equal(restored.clusters?.thermostat?.occupiedCoolingSetpoint, 2_400);
      assert.equal(restored.clusters?.fanControl?.percentSetting, 60);
      assert.equal(
        restored.clusters?.thermostat?.localTemperature,
        source === 'ambient' ? 2_123 : source === 'outlet' ? 1_655 : null,
      );
      assert.equal(
        restored.clusters?.relativeHumidityMeasurement?.measuredValue,
        source === 'ambient' ? 6_100 : undefined,
      );
      assert.equal(restored.firmwareRevision, '1.1.0.104');
      assert.deepEqual(
        Object.keys(restored.clusters ?? {}).sort(),
        Object.keys(cached.clusters ?? {}).sort(),
      );
      assert.deepEqual(
        Object.keys(restored.deviceType.behaviors).sort(),
        Object.keys(cached.deviceType.behaviors).sort(),
      );
    }

    const fresh = createWave3MatterAccessory(
      harness.matter,
      'matter-partial-fresh',
      device('ambient'),
      partial,
    );
    assert.equal(fresh.clusters?.onOff?.onOff, false);
    assert.equal(fresh.clusters?.thermostat?.systemMode, MATTER_SYSTEM_MODE.cool);
    assert.equal(fresh.clusters?.thermostat?.localTemperature, null);
    assert.equal(fresh.clusters?.fanControl?.percentSetting, 0);
    assert.equal(fresh.clusters?.relativeHumidityMeasurement?.measuredValue, 6_100);
  });

  it('derives behavior classes from the running Matter API device type', () => {
    const injectedRoomAirConditioner = deviceTypes.RoomAirConditioner.with(
      deviceTypes.RoomAirConditioner.requirements.RelativeHumidityMeasurementServer,
    );
    const matter = {
      ...matterHarness().matter,
      deviceTypes: {
        ...deviceTypes,
        RoomAirConditioner: injectedRoomAirConditioner,
      },
    } as unknown as MatterAPI;

    const deviceType = wave3RoomAirConditionerDeviceType(matter, 'outlet');
    assert.ok('relativeHumidityMeasurement' in deviceType.behaviors);
  });

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
        wave3RoomAirConditionerDeviceType(harness.matter, 'ambient').with(
          BridgedDeviceBasicInformationServer,
        ),
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
      assert.equal(supported.thermostat?.features.autoMode, false);
      assert.equal(supported.fanControl?.features.multiSpeed, true);
      assert.equal('thermostatUserInterfaceConfiguration' in supported, true);
      assert.equal(
        endpoint.state.thermostatUserInterfaceConfiguration.temperatureDisplayMode,
        MATTER_TEMPERATURE_DISPLAY_MODE.celsius,
      );
      await assert.rejects(
        async () => endpoint.act('reject unbound power command', agent => agent.onOff.on()),
        /unavailable until command mapping/,
      );
      assert.equal(endpoint.state.onOff.onOff, true);
      assert.equal(endpoint.state.thermostat.systemMode, MATTER_SYSTEM_MODE.cool);
      assert.equal(endpoint.state.fanControl.percentSetting, 60);
    } finally {
      await node.close();
    }
  });

  it('applies crossing heat and cool snapshots for every temperature shape in Matter', async () => {
    const baseMatter = matterHarness().matter;
    const environment = new Environment('wave3-matter-transition-test', Environment.default);
    new MockStorageService(environment);
    const node = await ServerNode.create({
      id: 'wave3-transition-node',
      environment,
      network: { port: 0 },
      productDescription: { name: 'WAVE transition test', deviceType: 0x000e },
      basicInformation: {
        vendorName: 'Test',
        vendorId: 0xfff1,
        productName: 'WAVE transition test',
        productId: 0x8000,
        nodeLabel: 'WAVE transition test',
        serialNumber: 'wave3-transition-test',
        hardwareVersion: 1,
        hardwareVersionString: '1',
        softwareVersion: 1,
        softwareVersionString: '1',
      },
    } as never);
    try {
      const aggregator = new Endpoint(AggregatorEndpoint, { id: 'wave3-transition-aggregator' });
      await node.add(aggregator);
      for (const source of ['ambient', 'outlet', 'none'] as const) {
        const controller = fakeController(offlineSnapshot());
        const accessory = createWave3MatterAccessory(
          baseMatter,
          `matter-runtime-transition-${source}`,
          device(source),
          controller.snapshot,
        );
        const endpoint = new Endpoint(
          wave3RoomAirConditionerDeviceType(baseMatter, source).with(
            BridgedDeviceBasicInformationServer,
          ),
          {
            id: accessory.UUID,
            ...accessory.clusters,
            bridgedDeviceBasicInformation: {
              vendorName: 'EcoFlow',
              nodeLabel: accessory.displayName,
              productName: 'WAVE 3',
              productLabel: 'WAVE 3',
              serialNumber: `redacted-transition-${source}`,
              reachable: true,
            },
          } as never,
        );
        await aggregator.add(endpoint);
        const endpointState = () => endpoint.state as unknown as {
          onOff: { onOff: boolean };
          thermostat: {
            localTemperature: number | null;
            systemMode: number;
            thermostatRunningMode?: number;
            occupiedCoolingSetpoint: number;
            occupiedHeatingSetpoint: number;
          };
          fanControl: { percentSetting: number | null };
          relativeHumidityMeasurement?: { measuredValue: number | null };
        };
        const runtimeMatter = {
          ...baseMatter,
          updateAccessoryState: async (
            _uuid: string,
            cluster: string,
            attributes: Record<string, unknown>,
          ) => {
            void endpoint.set({ [cluster]: attributes } as never);
          },
          getAccessoryState: async (_uuid: string, cluster: string) => {
            const state = endpoint.state as unknown as Record<string, Record<string, unknown>>;
            return state[cluster];
          },
        } as MatterAPI;
        const binding = new Wave3MatterAccessory(
          runtimeMatter,
          accessory,
          controller,
          source,
        );

        controller.emit(runtimeSnapshot('cool', 18, 40, 55));
        await waitUntil(
          () => endpointState().thermostat.systemMode === MATTER_SYSTEM_MODE.cool
            && endpointState().fanControl.percentSetting === 40,
        );
        assert.equal(endpointState().thermostat.occupiedCoolingSetpoint, 1_800);
        assert.equal(endpointState().thermostat.occupiedHeatingSetpoint, 1_800);

        controller.emit(runtimeSnapshot('heat', 23, 60, 56));
        await waitUntil(
          () => endpointState().thermostat.systemMode === MATTER_SYSTEM_MODE.heat
            && endpointState().fanControl.percentSetting === 60
            && (source !== 'ambient'
              || endpointState().relativeHumidityMeasurement?.measuredValue === 5_600),
        );
        await binding.stop();

        assert.equal(endpointState().onOff.onOff, true);
        assert.equal(endpointState().thermostat.occupiedCoolingSetpoint, 2_300);
        assert.equal(endpointState().thermostat.occupiedHeatingSetpoint, 2_300);
        assert.equal(endpointState().thermostat.thermostatRunningMode, undefined);
        assert.equal(
          endpointState().thermostat.localTemperature,
          source === 'ambient' ? 2_300 : source === 'outlet' ? 1_700 : null,
        );
        assert.equal(
          endpointState().relativeHumidityMeasurement?.measuredValue,
          source === 'ambient' ? 5_600 : undefined,
        );
      }
    } finally {
      await node.close();
    }
  });

  it('routes Matter controls through confirmed WAVE commands', async () => {
    const baseMatter = matterHarness().matter;
    const controller = recordingController(onlineSnapshot());
    const diagnostics: string[] = [];
    const errors: string[] = [];
    const accessory = createWave3MatterAccessory(
      baseMatter,
      'matter-runtime-controls',
      device('ambient'),
      controller.snapshot,
    );
    const environment = new Environment('wave3-matter-controls-test', Environment.default);
    new MockStorageService(environment);
    const node = await ServerNode.create({
      id: 'wave3-controls-node',
      environment,
      network: { port: 0 },
      productDescription: { name: 'WAVE controls test', deviceType: 0x000e },
      basicInformation: {
        vendorName: 'Test',
        vendorId: 0xfff1,
        productName: 'WAVE controls test',
        productId: 0x8000,
        nodeLabel: 'WAVE controls test',
        serialNumber: 'wave3-controls-test',
        hardwareVersion: 1,
        hardwareVersionString: '1',
        softwareVersion: 1,
        softwareVersionString: '1',
      },
    } as never);
    let binding: Wave3MatterAccessory | undefined;
    try {
      const aggregator = new Endpoint(AggregatorEndpoint, { id: 'wave3-controls-aggregator' });
      await node.add(aggregator);
      const endpoint = new Endpoint(
        wave3RoomAirConditionerDeviceType(baseMatter, 'ambient').with(
          BridgedDeviceBasicInformationServer,
        ),
        {
          id: accessory.UUID,
          ...accessory.clusters,
          bridgedDeviceBasicInformation: {
            vendorName: 'EcoFlow',
            nodeLabel: accessory.displayName,
            productName: 'WAVE 3',
            productLabel: 'WAVE 3',
            serialNumber: 'redacted-controls',
            reachable: true,
          },
        } as never,
      );
      await aggregator.add(endpoint);
      let stateUpdateGate: ReturnType<typeof deferred> | undefined;
      let dropNextThermostatStateUpdate = false;
      let droppedThermostatStateUpdates = 0;
      const runtimeMatter = {
        ...baseMatter,
        updateAccessoryState: async (
          _uuid: string,
          cluster: string,
          attributes: Record<string, unknown>,
        ) => {
          await stateUpdateGate?.promise;
          if (cluster === baseMatter.clusterNames.Thermostat && dropNextThermostatStateUpdate) {
            dropNextThermostatStateUpdate = false;
            droppedThermostatStateUpdates += 1;
            return;
          }
          void endpoint.set({ [cluster]: attributes } as never);
        },
        getAccessoryState: async (_uuid: string, cluster: string) => {
          const state = endpoint.state as unknown as Record<string, Record<string, unknown>>;
          return state[cluster];
        },
      } as MatterAPI;
      binding = new Wave3MatterAccessory(
        runtimeMatter,
        accessory,
        controller,
        'ambient',
        {
          debug: message => diagnostics.push(message),
          error: message => errors.push(message),
        },
      );
      const directControl = (binding as unknown as {
        createMatterControl(): {
          setPower(on: boolean, applyMatter: () => Promise<void>): Promise<void>;
          setSystemMode(value: number): void;
          setHeatingSetpoint(value: number): void;
          setCoolingSetpoint(value: number): void;
          raiseLowerSetpoint(
            mode: number,
            amount: number,
            applyMatter: () => Promise<void>,
          ): Promise<void>;
        };
      }).createMatterControl();

      await waitUntil(
        () => endpoint.state.bridgedDeviceBasicInformation.softwareVersionString === '1.1.0.104',
        'initial runtime firmware metadata',
      );
      controller.setSnapshot({
        ...onlineSnapshot(),
        firmwareVersions: { pd: '1.1.0.105' },
      });
      await waitUntil(
        () => endpoint.state.bridgedDeviceBasicInformation.softwareVersionString === '1.1.0.105',
        'updated runtime firmware metadata',
      );
      controller.setSnapshot(onlineSnapshot());

      await endpoint.act('turn off', agent => agent.onOff.off());
      const commandsBeforeModeWhileOff = controller.commands.length;
      await endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.heat } });
      await endpoint.set({ thermostat: { occupiedHeatingSetpoint: 2_000 } });
      await drainMicrotasks();
      assert.equal(controller.commands.length, commandsBeforeModeWhileOff);
      controller.setSnapshot({
        ...controller.snapshot,
        state: { ...controller.snapshot.state, ambientHumidityPercent: 55 },
      });
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.heat
          && endpoint.state.thermostat.occupiedHeatingSetpoint === 2_000,
        'staged off-state thermostat intent survives telemetry',
      );
      await endpoint.act('turn on', agent => agent.onOff.on());
      assert.deepEqual(controller.commands.slice(commandsBeforeModeWhileOff), [
        { type: 'power', on: true },
        { type: 'mode', mode: 'heat' },
        { type: 'targetTemperature', celsius: 20 },
      ]);
      assert.equal(controller.snapshot.state.powered, true);
      assert.equal(controller.snapshot.state.mode, 'heat');
      assert.equal(controller.snapshot.state.targetTemperatureCelsius, 20);

      await endpoint.act('turn off before delayed mode replay', agent => agent.onOff.off());
      const commandsBeforeDelayedModeReplay = controller.commands.length;
      await endpoint.set({ thermostat: {
        systemMode: MATTER_SYSTEM_MODE.cool,
        occupiedCoolingSetpoint: 2_200,
        occupiedHeatingSetpoint: 2_000,
      } });
      await endpoint.act('power on before delayed Heat write', agent => agent.onOff.on());
      await endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.heat } });
      await waitUntil(
        () => controller.snapshot.state.mode === 'heat'
          && controller.snapshot.state.targetTemperatureCelsius === 26,
        'delayed Heat write restores its authoritative saved profile',
      );
      assert.deepEqual(controller.commands.slice(commandsBeforeDelayedModeReplay), [
        { type: 'power', on: true },
        { type: 'mode', mode: 'cool' },
        { type: 'mode', mode: 'heat' },
      ]);

      await endpoint.act('turn off before unsupported Auto write', agent => agent.onOff.off());
      const commandsBeforeAutoStartup = controller.commands.length;
      await assert.rejects(
        async () => endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.auto } }),
        /constraint|conformance|allowed/i,
      );
      await endpoint.act('turn on after unsupported Auto write', agent => agent.onOff.on());
      assert.deepEqual(controller.commands.slice(commandsBeforeAutoStartup), [
        { type: 'power', on: true },
      ]);

      const powerBeforeRapidToggle = controller.commands.length;
      await Promise.all([
        directControl.setPower(false, async () => undefined),
        directControl.setPower(true, async () => undefined),
      ]);
      assert.deepEqual(controller.commands.slice(powerBeforeRapidToggle), [
        { type: 'power', on: false },
        { type: 'power', on: true },
      ]);
      for (const [systemMode, expected] of [
        [MATTER_SYSTEM_MODE.cool, { type: 'mode', mode: 'cool' }],
        [MATTER_SYSTEM_MODE.heat, { type: 'mode', mode: 'heat' }],
        [MATTER_SYSTEM_MODE.fan, { type: 'mode', mode: 'fan' }],
        [MATTER_SYSTEM_MODE.dry, { type: 'mode', mode: 'dry' }],
        [MATTER_SYSTEM_MODE.sleep, { type: 'submode', submode: 3 }],
      ] as const) {
        const before = controller.commands.length;
        await endpoint.set({ thermostat: { systemMode } });
        await waitUntil(
          () => controller.commands.length > before,
          `Matter system mode ${systemMode} command`,
        );
        assert.deepEqual(controller.commands.slice(before), [expected]);
        await waitUntil(
          () => endpoint.state.thermostat.systemMode === systemMode,
          `projected Matter system mode ${systemMode}`,
        );
      }

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'initial automatic mode projection',
      );
      dropNextThermostatStateUpdate = true;
      controller.setSnapshot({
        ...onlineSnapshot(),
        state: { ...onlineSnapshot().state, mode: 'cool', targetTemperatureCelsius: 21 },
      });
      await waitUntil(
        () => droppedThermostatStateUpdates === 1,
        'dropped stale thermostat projection',
      );
      await new Promise<void>(resolve => setTimeout(resolve, 550));
      controller.setSnapshot({
        ...onlineSnapshot(),
        state: { ...onlineSnapshot().state, mode: 'heat', targetTemperatureCelsius: 23 },
      });
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.heat,
        'newer confirmed heat projection',
      );
      const commandsBeforeFormerlyStaleMode = controller.commands.length;
      await endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.cool } });
      await waitUntil(
        () => controller.snapshot.state.mode === 'cool',
        'legitimate cool write after stale projection',
      );
      assert.deepEqual(controller.commands.slice(commandsBeforeFormerlyStaleMode), [
        { type: 'mode', mode: 'cool' },
      ]);

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: { ...onlineSnapshot().state, mode: 'cool', targetTemperatureCelsius: 22 },
      });
      const supersededIntentBefore = controller.commands.length;
      const supersededMode = controller.deferNextConfirmation();
      directControl.setSystemMode(MATTER_SYSTEM_MODE.heat);
      await supersededMode.started;
      directControl.setSystemMode(MATTER_SYSTEM_MODE.cool);
      directControl.setCoolingSetpoint(2_300);
      await drainMicrotasks();
      supersededMode.confirm();
      await waitUntil(
        () => controller.snapshot.state.mode === 'cool'
          && controller.snapshot.state.targetTemperatureCelsius === 23,
        'newer thermostat intent supersedes unfinished mode work',
      );
      assert.deepEqual(controller.commands.slice(supersededIntentBefore), [
        { type: 'mode', mode: 'heat' },
        { type: 'mode', mode: 'cool' },
        { type: 'targetTemperature', celsius: 23 },
      ]);

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: { ...onlineSnapshot().state, mode: 'cool', targetTemperatureCelsius: 22 },
      });
      const cancelledIntentBefore = controller.commands.length;
      const cancelledMode = controller.deferNextConfirmation();
      directControl.setSystemMode(MATTER_SYSTEM_MODE.heat);
      await cancelledMode.started;
      directControl.setHeatingSetpoint(2_000);
      await drainMicrotasks();
      const immediatePowerOff = directControl.setPower(false, async () => undefined);
      cancelledMode.confirm();
      await immediatePowerOff;
      await drainMicrotasks();
      assert.deepEqual(controller.commands.slice(cancelledIntentBefore), [
        { type: 'mode', mode: 'heat' },
        { type: 'power', on: false },
      ]);

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool
          && endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'baseline automatic range',
      );
      const heatingCrossingBefore = controller.commands.length;
      await endpoint.set({ thermostat: {
        occupiedHeatingSetpoint: 2_500,
        occupiedCoolingSetpoint: 2_900,
      } });
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureLowerCelsius === 25
          && controller.snapshot.state.targetTemperatureUpperCelsius === 29,
        'crossing heating WAVE range command',
      );
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 2_500
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_900,
        'crossing heating Matter range projection',
      );
      assert.deepEqual(controller.commands.slice(heatingCrossingBefore), [{
        type: 'automaticTemperatureRange',
        lowerCelsius: 25,
        upperCelsius: 29,
      }]);
      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'restored range before lowering cooling threshold',
      );
      const coolingCrossingBefore = controller.commands.length;
      await endpoint.set({ thermostat: {
        occupiedHeatingSetpoint: 1_600,
        occupiedCoolingSetpoint: 2_000,
      } });
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureLowerCelsius === 16
          && controller.snapshot.state.targetTemperatureUpperCelsius === 20
          && endpoint.state.thermostat.occupiedHeatingSetpoint === 1_600
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_000,
        'crossing cooling setpoint and companion heating setpoint',
      );
      assert.deepEqual(controller.commands.slice(coolingCrossingBefore), [{
        type: 'automaticTemperatureRange',
        lowerCelsius: 16,
        upperCelsius: 20,
      }]);

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'restored automatic range',
      );
      await endpoint.set({ thermostat: { occupiedHeatingSetpoint: 2_000 } });
      await waitUntil(
        () => controller.commands.at(-1)?.type === 'automaticTemperatureRange'
          && controller.snapshot.state.targetTemperatureLowerCelsius === 20,
        'active automatic lower-setpoint command',
      );
      await endpoint.set({ thermostat: { occupiedCoolingSetpoint: 2_500 } });
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureUpperCelsius === 25,
        'active automatic upper-setpoint projection',
      );
      assert.deepEqual(controller.commands.slice(-2), [
        {
          type: 'automaticTemperatureRange',
          lowerCelsius: 20,
          upperCelsius: 24,
        },
        {
          type: 'automaticTemperatureRange',
          lowerCelsius: 20,
          upperCelsius: 25,
        },
      ]);

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'rapid direct setpoint baseline',
      );
      const rapidDirectBefore = controller.commands.length;
      directControl.setHeatingSetpoint(2_000);
      directControl.setCoolingSetpoint(2_500);
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureLowerCelsius === 20
          && controller.snapshot.state.targetTemperatureUpperCelsius === 25,
        'rapid direct setpoints',
      );
      const rapidDirectCommands = controller.commands.slice(rapidDirectBefore);
      assert.equal(rapidDirectCommands.length >= 1, true);
      assert.deepEqual(rapidDirectCommands.at(-1), {
        type: 'automaticTemperatureRange',
        lowerCelsius: 20,
        upperCelsius: 25,
      });

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: {
          ...onlineSnapshot().state,
          mode: 'cool',
          targetTemperatureCelsius: 22,
        },
      });
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'cool projection before direct setpoint writes',
      );
      const coolTargetBefore = controller.commands.length;
      await endpoint.set({ thermostat: { occupiedCoolingSetpoint: 2_300 } });
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureCelsius === 23,
        'active cooling setpoint command',
      );
      assert.deepEqual(controller.commands.slice(coolTargetBefore), [{
        type: 'targetTemperature',
        celsius: 23,
      }]);

      const inactiveHeatBefore = controller.commands.length;
      await endpoint.set({ thermostat: { occupiedHeatingSetpoint: 2_100 } });
      await drainMicrotasks();
      assert.deepEqual(
        controller.commands.slice(inactiveHeatBefore),
        [],
        'inactive Heat companion must not command the active Cool profile',
      );

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: {
          ...onlineSnapshot().state,
          mode: 'heat',
          targetTemperatureCelsius: 22,
        },
      });
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.heat,
        'active Heat raise/lower mode projection',
      );
      const heatTargetBefore = controller.commands.length;
      await endpoint.set({ thermostat: { occupiedHeatingSetpoint: 2_300 } });
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureCelsius === 23,
        'active heating setpoint command',
      );
      assert.deepEqual(controller.commands.slice(heatTargetBefore), [{
        type: 'targetTemperature',
        celsius: 23,
      }]);

      const inactiveCoolBefore = controller.commands.length;
      await endpoint.set({ thermostat: { occupiedCoolingSetpoint: 2_500 } });
      await drainMicrotasks();
      assert.equal(
        controller.commands.length,
        inactiveCoolBefore,
        'inactive Cool companion must not command the active Heat profile',
      );

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'automatic projection before fan controls',
      );

      const airflowBeforeSlider = controller.commands.filter(
        command => command.type === 'airflowSpeed',
      ).length;
      await endpoint.set({ fanControl: { percentSetting: 22 } });
      await endpoint.set({ fanControl: { percentSetting: 63 } });
      await endpoint.set({ fanControl: { percentSetting: 78 } });
      await waitUntil(
        () => controller.commands.some(command => command.type === 'airflowSpeed'),
        'settled fan command',
      );
      await waitUntil(
        () => endpoint.state.fanControl.percentSetting === 80
          && endpoint.state.fanControl.speedSetting === 4,
        'confirmed fan state',
      );
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      assert.equal(
        controller.commands.filter(command => command.type === 'airflowSpeed').length,
        airflowBeforeSlider + 1,
      );
      assert.deepEqual(controller.commands.at(-1), { type: 'airflowSpeed', speed: 80 });
      await endpoint.set({ fanControl: { percentSetting: null } });
      await endpoint.set({ fanControl: { speedSetting: null } });
      assert.equal(endpoint.state.fanControl.percentSetting, 80);
      assert.equal(endpoint.state.fanControl.speedSetting, 4);

      const airflowBeforeReturnToConfirmed = controller.commands.filter(
        command => command.type === 'airflowSpeed',
      ).length;
      await endpoint.set({ fanControl: { percentSetting: 40 } });
      await waitUntil(
        () => endpoint.state.fanControl.fanMode === 2
          && endpoint.state.fanControl.percentSetting === 40
          && endpoint.state.fanControl.speedSetting === 2,
        'coherent pending 40 percent fan state',
      );
      await endpoint.set({ fanControl: { percentSetting: 80 } });
      await waitUntil(
        () => endpoint.state.fanControl.fanMode === 3
          && endpoint.state.fanControl.percentSetting === 80
          && endpoint.state.fanControl.speedSetting === 4,
        'coherent pending 80 percent fan state',
      );
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      assert.equal(
        controller.commands.filter(command => command.type === 'airflowSpeed').length,
        airflowBeforeReturnToConfirmed,
      );
      assert.deepEqual(controller.commands.slice(0, 4), [
        { type: 'power', on: false },
        { type: 'power', on: true },
        { type: 'mode', mode: 'heat' },
        { type: 'targetTemperature', celsius: 20 },
      ]);

      for (const [fanMode, speed] of [[1, 20], [2, 60], [3, 100]] as const) {
        const before = controller.commands.filter(command => command.type === 'airflowSpeed').length;
        await endpoint.set({ fanControl: { fanMode } });
        await waitUntil(
          () => controller.snapshot.state.airflowSpeed === speed,
          `fan mode ${fanMode} command`,
        );
        assert.equal(
          controller.commands.filter(command => command.type === 'airflowSpeed').length,
          before + 1,
        );
        assert.deepEqual(controller.commands.at(-1), { type: 'airflowSpeed', speed });
      }

      for (const [speedSetting, speed] of [[2, 40], [3, 60], [4, 80]] as const) {
        const before = controller.commands.filter(command => command.type === 'airflowSpeed').length;
        await endpoint.set({ fanControl: { speedSetting } });
        await waitUntil(
          () => controller.snapshot.state.airflowSpeed === speed,
          `fan speed-setting ${speedSetting} command`,
        );
        assert.equal(
          controller.commands.filter(command => command.type === 'airflowSpeed').length,
          before + 1,
        );
        assert.deepEqual(controller.commands.at(-1), { type: 'airflowSpeed', speed });
      }

      await assert.rejects(endpoint.set({ fanControl: { percentSetting: 0 } }), error => {
        assert.ok(error instanceof MatterStatus.InvalidInState);
        assert.match(error.message, /power control to turn off/);
        return true;
      });
      await assert.rejects(endpoint.set({ fanControl: { fanMode: 4 } }), error => {
        assert.ok(error instanceof MatterStatus.ConstraintError);
        assert.match(error.message, /Unsupported Matter fan mode/);
        return true;
      });

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: {
          ...onlineSnapshot().state,
          targetTemperatureLowerCelsius: 19,
          targetTemperatureUpperCelsius: 24,
        },
      });
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'raise/lower baseline range',
      );
      await endpoint.act('raise heat across cool', agent => agent.thermostat.setpointRaiseLower({
        mode: 0,
        amount: 60,
      }));
      assert.deepEqual(controller.commands.at(-1), {
        type: 'automaticTemperatureRange',
        lowerCelsius: 25,
        upperCelsius: 29,
      });
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 2_500
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_900,
        'raised automatic range projection',
      );

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: {
          ...onlineSnapshot().state,
          targetTemperatureLowerCelsius: 19,
          targetTemperatureUpperCelsius: 24,
        },
      });
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'lower cool baseline range',
      );
      await endpoint.act('lower cool across heat', agent => agent.thermostat.setpointRaiseLower({
        mode: 1,
        amount: -60,
      }));
      assert.deepEqual(controller.commands.at(-1), {
        type: 'automaticTemperatureRange',
        lowerCelsius: 16,
        upperCelsius: 20,
      });
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_600
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_000,
        'lowered automatic range projection',
      );

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: {
          ...onlineSnapshot().state,
          targetTemperatureLowerCelsius: 19,
          targetTemperatureUpperCelsius: 24,
        },
      });
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'rapid raise/lower baseline range',
      );
      const rapidRaiseBefore = controller.commands.length;
      await Promise.all([
        directControl.raiseLowerSetpoint(0, 10, async () => undefined),
        directControl.raiseLowerSetpoint(0, 10, async () => undefined),
      ]);
      assert.deepEqual(controller.commands.slice(rapidRaiseBefore), [
        {
          type: 'automaticTemperatureRange',
          lowerCelsius: 20,
          upperCelsius: 24,
        },
        {
          type: 'automaticTemperatureRange',
          lowerCelsius: 21,
          upperCelsius: 25,
        },
      ]);

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: {
          ...onlineSnapshot().state,
          targetTemperatureLowerCelsius: 19,
          targetTemperatureUpperCelsius: 24,
        },
      });
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'both-setpoint baseline range',
      );
      await endpoint.act('raise both to upper limit', agent => agent.thermostat.setpointRaiseLower({
        mode: 2,
        amount: 100,
      }));
      assert.deepEqual(controller.commands.at(-1), {
        type: 'automaticTemperatureRange',
        lowerCelsius: 25,
        upperCelsius: 30,
      });
      await endpoint.act('lower both to lower limit', agent => agent.thermostat.setpointRaiseLower({
        mode: 2,
        amount: -200,
      }));
      assert.deepEqual(controller.commands.at(-1), {
        type: 'automaticTemperatureRange',
        lowerCelsius: 16,
        upperCelsius: 21,
      });

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: { ...onlineSnapshot().state, mode: 'heat', targetTemperatureCelsius: 22 },
      });
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.heat,
        'active heat projection before raise/lower',
      );
      await endpoint.act('raise active heat target', agent => agent.thermostat.setpointRaiseLower({
        mode: 0,
        amount: 10,
      }));
      assert.deepEqual(controller.commands.at(-1), { type: 'targetTemperature', celsius: 23 });
      await assert.rejects(
        async () => endpoint.act(
          'reject inactive cooling adjustment',
          agent => agent.thermostat.setpointRaiseLower({ mode: 1, amount: 10 }),
        ),
        error => {
          assert.ok(error instanceof MatterStatus.InvalidInState);
          return true;
        },
      );

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: { ...onlineSnapshot().state, mode: 'cool', targetTemperatureCelsius: 22 },
      });
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'active Cool raise/lower mode projection',
      );
      await endpoint.act('raise active cool target', agent => agent.thermostat.setpointRaiseLower({
        mode: 1,
        amount: 10,
      }));
      assert.deepEqual(controller.commands.at(-1), { type: 'targetTemperature', celsius: 23 });
      await assert.rejects(
        async () => endpoint.act(
          'reject inactive heating adjustment',
          agent => agent.thermostat.setpointRaiseLower({ mode: 0, amount: 10 }),
        ),
        error => {
          assert.ok(error instanceof MatterStatus.InvalidInState);
          return true;
        },
      );

      controller.setSnapshot({
        ...onlineSnapshot(),
        state: { ...onlineSnapshot().state, mode: 'fan' },
      });
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.fan,
        'Fan mode projection',
      );
      await assert.rejects(
        async () => endpoint.act(
          'reject inactive fan-mode setpoint adjustment',
          agent => agent.thermostat.setpointRaiseLower({ mode: 0, amount: 10 }),
        ),
        error => {
          assert.ok(error instanceof MatterStatus.InvalidInState);
          return true;
        },
      );

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'Auto mode projection before invalid raise/lower',
      );
      await assert.rejects(
        async () => endpoint.act(
          'reject invalid setpoint-adjustment mode',
          agent => agent.thermostat.setpointRaiseLower({ mode: 99 as never, amount: 10 }),
        ),
        error => {
          assert.ok(error instanceof MatterStatus.InvalidInState);
          return true;
        },
      );

      for (const [reason, StatusType] of [
        ['timeout', MatterStatus.Timeout],
        ['acknowledgementRejected', MatterStatus.Failure],
      ] as const) {
        controller.failNext(reason);
        await assert.rejects(
          async () => endpoint.act(
            `failed setpoint adjustment: ${reason}`,
            agent => agent.thermostat.setpointRaiseLower({ mode: 2, amount: 10 }),
          ),
          error => {
            assert.ok(error instanceof StatusType);
            assert.equal(MatterStatus.isMatterProtocolError(error), true);
            return true;
          },
        );
      }

      const interruptedSetpoint = controller.deferNextFailure();
      const setpointDuringReconnect = endpoint.act(
        'setpoint adjustment interrupted by reconnect',
        agent => agent.thermostat.setpointRaiseLower({ mode: 2, amount: 10 }),
      );
      await interruptedSetpoint.started;
      controller.setSnapshot({
        ...controller.snapshot,
        availability: 'reconnecting',
      });
      interruptedSetpoint.fail('disconnected');
      await assert.rejects(async () => setpointDuringReconnect, error => {
        assert.ok(error instanceof MatterStatus.InvalidInState);
        return true;
      });
      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'automatic projection before deferred setpoint failure',
      );

      for (const [reason, StatusType, message] of [
        ['publicationFailed', MatterStatus.Failure, /cloud did not accept/],
        ['acknowledgementRejected', MatterStatus.Failure, /rejected the command/],
        ['timeout', MatterStatus.Timeout, /did not confirm/],
        ['disconnected', MatterStatus.InvalidInState, /not currently controllable/],
        ['stopped', MatterStatus.InvalidInState, /not currently controllable/],
      ] as const) {
        controller.failNext(reason);
        await assert.rejects(
          async () => endpoint.act(`failed power command: ${reason}`, agent => agent.onOff.off()),
          error => {
            assert.ok(error instanceof StatusType);
            assert.equal(MatterStatus.isMatterProtocolError(error), true);
            assert.match(error.message, message);
            return true;
          },
        );
      }
      assert.equal(endpoint.state.onOff.onOff, true);

      const inFlightReconnect = controller.deferNextFailure();
      const interruptedPower = endpoint.act(
        'power command interrupted by reconnect',
        agent => agent.onOff.off(),
      );
      await inFlightReconnect.started;
      controller.setSnapshot({
        ...controller.snapshot,
        availability: 'reconnecting',
      });
      inFlightReconnect.fail('disconnected');
      await assert.rejects(async () => interruptedPower, error => {
        assert.ok(error instanceof MatterStatus.InvalidInState);
        assert.equal(MatterStatus.isMatterProtocolError(error), true);
        assert.match(error.message, /not currently controllable/);
        return true;
      });
      assert.equal(endpoint.state.onOff.onOff, true);

      for (const availability of ['reconnecting', 'accountError'] as const) {
        controller.setSnapshot({
          ...controller.snapshot,
          availability,
        });
        await assert.rejects(
          async () => endpoint.act(`${availability} power command`, agent => agent.onOff.off()),
          error => {
            assert.ok(error instanceof MatterStatus.InvalidInState);
            assert.equal(MatterStatus.isMatterProtocolError(error), true);
            assert.match(error.message, /not currently controllable/);
            return true;
          },
        );
      }
      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'automatic projection after command failure matrix',
      );

      let errorCount = errors.length;
      const interruptedModeCommand = controller.deferNextFailure();
      await endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.heat } });
      await interruptedModeCommand.started;
      controller.setSnapshot({
        ...controller.snapshot,
        availability: 'reconnecting',
      });
      interruptedModeCommand.fail('disconnected');
      await waitUntil(
        () => errors.length === errorCount + 1,
        'failed mode command during reconnect',
      );
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'confirmed mode restoration during reconnect',
      );

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.fanControl.speedSetting === 3,
        'fan projection before deferred fan failure',
      );
      errorCount = errors.length;
      const interruptedFanCommand = controller.deferNextFailure();
      await endpoint.set({ fanControl: { speedSetting: 1 } });
      await interruptedFanCommand.started;
      controller.setSnapshot({
        ...controller.snapshot,
        availability: 'accountError',
      });
      interruptedFanCommand.fail('disconnected');
      await waitUntil(
        () => errors.length === errorCount + 1,
        'failed fan command during account error',
      );
      await waitUntil(
        () => endpoint.state.fanControl.speedSetting === 3
          && endpoint.state.fanControl.percentSetting === 60,
        'confirmed fan restoration during account error',
      );
      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'automatic projection before pending fan cancellation',
      );

      const airflowBeforePowerOff = controller.commands.filter(
        command => command.type === 'airflowSpeed',
      ).length;
      await endpoint.set({ fanControl: { percentSetting: 40 } });
      await endpoint.act('turn off while fan is pending', agent => agent.onOff.off());
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      assert.equal(
        controller.commands.filter(command => command.type === 'airflowSpeed').length,
        airflowBeforePowerOff,
      );
      await endpoint.act('turn back on after fan cancellation', agent => agent.onOff.on());

      stateUpdateGate = deferred();
      controller.setSnapshot({
        ...controller.snapshot,
        state: {
          ...controller.snapshot.state,
          ambientHumidityPercent: 51,
        },
      });
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      const airflowBeforeStalledPowerOff = controller.commands.filter(
        command => command.type === 'airflowSpeed',
      ).length;
      await endpoint.set({ fanControl: { percentSetting: 40 } });
      const stalledPowerOff = endpoint.act(
        'turn off behind stalled update',
        agent => agent.onOff.off(),
      );
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      assert.equal(
        controller.commands.filter(command => command.type === 'airflowSpeed').length,
        airflowBeforeStalledPowerOff,
      );
      stateUpdateGate.resolve();
      stateUpdateGate = undefined;
      await stalledPowerOff;
      await endpoint.act('turn back on after stalled cancellation', agent => agent.onOff.on());

      controller.setSnapshot({
        ...controller.snapshot,
        state: {
          ...controller.snapshot.state,
          temperatureDisplayUnit: 'celsius',
        },
      });
      await waitUntil(
        () => endpoint.state.thermostatUserInterfaceConfiguration.temperatureDisplayMode
          === MATTER_TEMPERATURE_DISPLAY_MODE.celsius,
        'Celsius display preference projection',
      );
      const commandsBeforeFahrenheit = controller.commands.length;
      await endpoint.set({
        thermostatUserInterfaceConfiguration: {
          temperatureDisplayMode: MATTER_TEMPERATURE_DISPLAY_MODE.fahrenheit,
        },
      });
      await waitUntil(
        () => controller.snapshot.state.temperatureDisplayUnit === 'fahrenheit',
        'Fahrenheit display preference command',
      );
      await waitUntil(
        () => endpoint.state.thermostatUserInterfaceConfiguration.temperatureDisplayMode
          === MATTER_TEMPERATURE_DISPLAY_MODE.fahrenheit,
        'Fahrenheit display preference projection',
      );
      assert.deepEqual(controller.commands.slice(commandsBeforeFahrenheit), [{
        type: 'temperatureDisplayUnit',
        unit: 'fahrenheit',
      }]);
      assert.equal(controller.snapshot.state.ambientTemperatureCelsius, 21.23);

      controller.failNext('timeout');
      errorCount = errors.length;
      await endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.heat } });
      await waitUntil(
        () => errors.length === errorCount + 1,
        'failed attribute command reconciliation',
      );
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.cool,
        'confirmed thermostat restoration',
      );
      assert.match(errors.at(-1)!, /command confirmation timed out/);

      const airflowCommands = controller.commands.filter(command => command.type === 'airflowSpeed').length;
      await endpoint.set({ fanControl: { percentSetting: 40 } });
      await binding.stop();
      binding = undefined;
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      assert.equal(
        controller.commands.filter(command => command.type === 'airflowSpeed').length,
        airflowCommands,
      );
    } finally {
      await binding?.stop();
      await node.close();
    }
    assert.deepEqual(errors, [
      'EcoFlow WAVE 3 Matter setpoint adjustment command failed: Cooling setpoint is not active',
      'EcoFlow WAVE 3 Matter setpoint adjustment command failed: Heating setpoint is not active',
      'EcoFlow WAVE 3 Matter setpoint adjustment command failed: Heating setpoint is not active',
      'EcoFlow WAVE 3 Matter setpoint adjustment command failed: Requested setpoint adjustment is not active',
      'EcoFlow WAVE 3 Matter setpoint adjustment command confirmation timed out: EcoFlow WAVE 3 did not confirm within the command deadline',
      'EcoFlow WAVE 3 Matter setpoint adjustment command failed: EcoFlow WAVE 3 rejected the command',
      'EcoFlow WAVE 3 Matter setpoint adjustment command failed: EcoFlow WAVE 3 is not currently controllable',
      'EcoFlow WAVE 3 Matter power command failed: EcoFlow cloud did not accept the command',
      'EcoFlow WAVE 3 Matter power command failed: EcoFlow WAVE 3 rejected the command',
      'EcoFlow WAVE 3 Matter power command confirmation timed out: EcoFlow WAVE 3 did not confirm within the command deadline',
      ...Array<string>(5).fill(
        'EcoFlow WAVE 3 Matter power command failed: EcoFlow WAVE 3 is not currently controllable',
      ),
      'EcoFlow WAVE 3 Matter system mode command failed: EcoFlow WAVE 3 is not currently controllable',
      'EcoFlow WAVE 3 Matter fan speed command failed: EcoFlow WAVE 3 is not currently controllable',
      'EcoFlow WAVE 3 Matter system mode command confirmation timed out: EcoFlow WAVE 3 did not confirm within the command deadline',
    ]);
    assert.equal(errors.some(message => /cloud did not accept the command/.test(message)), true);
    assert.equal(errors.some(message => /rejected the command/.test(message)), true);
    assert.equal(errors.some(message => /command confirmation timed out/.test(message)), true);
    assert.equal(errors.some(message => /not currently controllable/.test(message)), true);
    assert.equal(
      errors.some(message => /system mode command confirmation timed out/.test(message)),
      true,
    );
    assert.equal(diagnostics.some(message => /Matter write power=/.test(message)), true);
    assert.equal(diagnostics.some(message => /Matter write systemMode=/.test(message)), true);
    assert.equal(diagnostics.some(message => /Matter write heatingSetpointCelsius=/.test(message)), true);
    assert.equal(diagnostics.some(message => /Matter write setpointRaiseLower/.test(message)), true);
    assert.equal(diagnostics.some(message => /Matter write fan(Mode|Percent|Speed)=/.test(message)), true);
    assert.equal(diagnostics.some(message => /redacted-controls|TEST-SERIAL/.test(message)), false);
  });

  it('builds a customized room air conditioner with manual HVAC, fan, humidity, and complete state', () => {
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
      autoMode: false,
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
      absMinHeatSetpointLimit: 1_600,
      minHeatSetpointLimit: 1_600,
      maxHeatSetpointLimit: 3_000,
      absMaxHeatSetpointLimit: 3_000,
      absMinCoolSetpointLimit: 1_600,
      minCoolSetpointLimit: 1_600,
      maxCoolSetpointLimit: 3_000,
      absMaxCoolSetpointLimit: 3_000,
      controlSequenceOfOperation: 4,
      systemMode: MATTER_SYSTEM_MODE.cool,
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

    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, 1);
    assert.deepEqual(harness.stateUpdates[0], {
      cluster: 'bridgedDeviceBasicInformation',
      attributes: { reachable: false },
    });
    controller.emit(onlineSnapshot());
    await drainMicrotasks();
    assert.deepEqual(
      harness.stateUpdates.map(update => update.cluster),
      [
        'bridgedDeviceBasicInformation',
        'bridgedDeviceBasicInformation',
        'onOff',
        'thermostat',
        'thermostatUserInterfaceConfiguration',
        'fanControl',
        'relativeHumidityMeasurement',
        'bridgedDeviceBasicInformation',
      ],
    );
    assert.deepEqual(
      harness.stateUpdates.find(update => 'softwareVersion' in update.attributes)?.attributes,
      {
        softwareVersion: 16_842_856,
        softwareVersionString: '1.1.0.104',
      },
    );
    assert.equal(
      harness.stateUpdates.find(update => update.cluster === 'onOff')?.attributes.onOff,
      true,
    );
    assert.equal(harness.metadataUpdates.length, 0);

    controller.emit({
      ...onlineSnapshot(),
      firmwareVersions: { pd: '1.1.0.105' },
    });
    await waitUntil(() => accessory.context.firmwareRevision === '1.1.0.105');
    assert.deepEqual(
      harness.stateUpdates.filter(
        update => update.cluster === 'bridgedDeviceBasicInformation',
      ).at(-1)?.attributes,
      {
        softwareVersion: 16_842_857,
        softwareVersionString: '1.1.0.105',
      },
    );

    (binding as unknown as { restoreConfirmedState(): void }).restoreConfirmedState();
    controller.emit({
      ...onlineSnapshot(),
      state: { ...onlineSnapshot().state, mode: 'heat', targetTemperatureCelsius: 23 },
      firmwareVersions: { pd: '1.1.0.105' },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    await drainMicrotasks();
    assert.equal(
      harness.stateUpdates.filter(update => update.cluster === 'thermostat').at(-1)
        ?.attributes.systemMode,
      MATTER_SYSTEM_MODE.heat,
    );

    harness.dropNextFirmwareUpdate();
    controller.emit({
      ...onlineSnapshot(),
      firmwareVersions: { pd: '1.1.0.106' },
    });
    await new Promise<void>(resolve => setTimeout(resolve, 550));
    assert.equal(accessory.context.firmwareRevision, '1.1.0.105');
    controller.emit({
      ...onlineSnapshot(),
      firmwareVersions: { pd: '1.1.0.106' },
    });
    await waitUntil(() => accessory.context.firmwareRevision === '1.1.0.106');
    const afterFirmwareUpdate = harness.stateUpdates.length;

    controller.emit({
      ...onlineSnapshot(),
      availability: 'stale',
      state: { powered: false },
    });
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, afterFirmwareUpdate);

    controller.emit({
      availability: 'reconnecting',
      state: { powered: false },
      modeProfiles: {},
      runtimeTemperatures: {},
    });
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, afterFirmwareUpdate);

    controller.emit({
      availability: 'accountError',
      state: { powered: false },
      modeProfiles: {},
      runtimeTemperatures: {},
    });
    await drainMicrotasks();
    assert.deepEqual(harness.stateUpdates.at(-1), {
      cluster: 'bridgedDeviceBasicInformation',
      attributes: { reachable: false },
    });
    const afterAccountError = harness.stateUpdates.length;

    await binding.stop();
    controller.emit(onlineSnapshot());
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, afterAccountError);
  });

  it('serves recent cached state read-only, then expires it to No Response', async () => {
    const harness = matterHarness();
    const cached = createWave3MatterAccessory(
      harness.matter,
      'matter-recent-cache',
      device('ambient'),
      { ...onlineSnapshot(), updatedAt: 995 },
    );
    const restored = createWave3MatterAccessory(
      harness.matter,
      cached.UUID,
      device('ambient'),
      offlineSnapshot(),
      cached,
    );
    const controller = fakeController(offlineSnapshot());
    let now = 1_000;
    const binding = new Wave3MatterAccessory(
      harness.matter,
      restored,
      controller,
      'ambient',
      { error: () => undefined },
      () => now,
      10,
    );

    await drainMicrotasks();
    assert.equal(
      harness.stateUpdates.some(
        update => update.attributes.reachable === false,
      ),
      false,
    );

    now = 1_006;
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    await drainMicrotasks();
    assert.deepEqual(
      harness.stateUpdates.filter(update => 'reachable' in update.attributes).at(-1),
      {
        cluster: 'bridgedDeviceBasicInformation',
        attributes: { reachable: false },
      },
    );

    now = 1_007;
    controller.emit({ ...onlineSnapshot(), updatedAt: 1_007 });
    await drainMicrotasks();
    assert.deepEqual(
      harness.stateUpdates.filter(update => 'reachable' in update.attributes).at(-1),
      {
        cluster: 'bridgedDeviceBasicInformation',
        attributes: { reachable: true },
      },
    );
    assert.equal(restored.context.lastConfirmedAt, 1_007);

    await binding.stop();
  });

  it('ignores stale partial startup telemetry until authoritative state arrives', async () => {
    const harness = matterHarness();
    const controller = fakeController(offlineSnapshot());
    const accessory = createWave3MatterAccessory(
      harness.matter,
      'matter-partial-binding',
      device('ambient'),
      controller.snapshot,
    );
    const binding = new Wave3MatterAccessory(
      harness.matter,
      accessory,
      controller,
      'ambient',
    );

    controller.emit({
      availability: 'stale',
      state: { ambientHumidityPercent: 62 },
      modeProfiles: {},
      runtimeTemperatures: {},
    });
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, 1);
    assert.deepEqual(harness.stateUpdates[0], {
      cluster: 'bridgedDeviceBasicInformation',
      attributes: { reachable: false },
    });

    controller.emit(onlineSnapshot());
    await drainMicrotasks();
    assert.equal(
      harness.stateUpdates.filter(update => update.cluster === 'onOff').at(-1)?.attributes.onOff,
      true,
    );
    assert.equal(
      harness.stateUpdates.filter(
        update => update.cluster === 'thermostat',
      ).at(-1)?.attributes.systemMode,
      MATTER_SYSTEM_MODE.cool,
    );
    await binding.stop();
  });

  it('does not resume snapshot updates after stop during an awaited update', async () => {
    const updateGate = deferred();
    const harness = matterHarness(updateGate);
    const controller = fakeController(offlineSnapshot());
    const accessory = createWave3MatterAccessory(
      harness.matter,
      'matter-uuid:stopping',
      device('ambient'),
      controller.snapshot,
    );
    const binding = new Wave3MatterAccessory(
      harness.matter,
      accessory,
      controller,
      'ambient',
    );

    controller.emit(onlineSnapshot());
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, 1);
    const stopping = binding.stop();
    updateGate.resolve();
    await stopping;
    assert.equal(harness.stateUpdates.length, 1);
  });
});

function matterHarness(updateGate?: ReturnType<typeof deferred>): {
  dropNextFirmwareUpdate(): void;
  matter: MatterAPI;
  stateUpdates: Array<{ cluster: string; attributes: Record<string, unknown> }>;
  metadataUpdates: MatterAccessory[];
  } {
  const stateUpdates: Array<{ cluster: string; attributes: Record<string, unknown> }> = [];
  const metadataUpdates: MatterAccessory[] = [];
  let dropNextFirmwareUpdate = false;
  const clusterState = new Map<string, Record<string, unknown>>([
    ['bridgedDeviceBasicInformation', {}],
  ]);
  return {
    matter: {
      deviceTypes,
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
        if (cluster === 'bridgedDeviceBasicInformation' && dropNextFirmwareUpdate) {
          dropNextFirmwareUpdate = false;
          return;
        }
        const applyUpdate = () => {
          clusterState.set(cluster, { ...clusterState.get(cluster), ...attributes });
        };
        if (updateGate === undefined) {
          applyUpdate();
        } else {
          void updateGate.promise.then(applyUpdate);
        }
      },
      getAccessoryState: async (_uuid: string, cluster: string) => clusterState.get(cluster),
      updatePlatformAccessories: async (accessories: MatterAccessory[]) => {
        metadataUpdates.push(...accessories);
      },
    } as unknown as MatterAPI,
    dropNextFirmwareUpdate: () => {
      dropNextFirmwareUpdate = true;
    },
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

function recordingController(initial: Wave3ControllerSnapshot): Wave3AccessoryController & {
  commands: Wave3Command[];
  deferNextConfirmation(): {
    started: Promise<void>;
    confirm(): void;
  };
  deferNextFailure(): {
    started: Promise<void>;
    fail(reason: Wave3CommandFailure): void;
  };
  failNext(reason: Wave3CommandFailure): void;
  setSnapshot(snapshot: Wave3ControllerSnapshot): void;
} {
  let snapshot = initial;
  let listener: ((snapshot: Wave3ControllerSnapshot) => void) | undefined;
  const commands: Wave3Command[] = [];
  let nextFailure: Wave3CommandFailure | undefined;
  let deferredConfirmation: {
    started: ReturnType<typeof deferred>;
    confirmation: ReturnType<typeof deferred>;
  } | undefined;
  let deferredExecution: {
    started: ReturnType<typeof deferred>;
    failure: Promise<Wave3CommandFailure>;
  } | undefined;
  return {
    get snapshot() {
      return snapshot;
    },
    commands,
    deferNextConfirmation() {
      assert.equal(deferredConfirmation, undefined);
      const started = deferred();
      const confirmation = deferred();
      deferredConfirmation = { started, confirmation };
      return {
        started: started.promise,
        confirm() {
          confirmation.resolve();
        },
      };
    },
    deferNextFailure() {
      assert.equal(deferredExecution, undefined);
      const started = deferred();
      let resolveFailure!: (reason: Wave3CommandFailure) => void;
      const failure = new Promise<Wave3CommandFailure>(resolve => {
        resolveFailure = resolve;
      });
      deferredExecution = { started, failure };
      return {
        started: started.promise,
        fail(reason) {
          resolveFailure(reason);
        },
      };
    },
    failNext(reason) {
      nextFailure = reason;
    },
    setSnapshot(value) {
      snapshot = value;
      listener?.(value);
    },
    onSnapshot: value => {
      listener = value;
      return () => {
        listener = undefined;
      };
    },
    execute: async command => {
      commands.push(command);
      if (deferredConfirmation !== undefined) {
        const execution = deferredConfirmation;
        deferredConfirmation = undefined;
        execution.started.resolve();
        await execution.confirmation.promise;
      }
      if (deferredExecution !== undefined) {
        const execution = deferredExecution;
        deferredExecution = undefined;
        execution.started.resolve();
        const reason = await execution.failure;
        return { status: 'failed', sequence: commands.length, reason };
      }
      if (nextFailure !== undefined) {
        const reason = nextFailure;
        nextFailure = undefined;
        return { status: 'failed', sequence: commands.length, reason };
      }
      const state = { ...snapshot.state };
      switch (command.type) {
      case 'power':
        state.powered = command.on;
        break;
      case 'mode':
        state.mode = command.mode;
        state.powered = true;
        state.submode = 0;
        if (command.targetTemperatureCelsius === undefined) {
          state.targetTemperatureCelsius = snapshot.modeProfiles[command.mode]
            ?.targetTemperatureCelsius;
        }
        if (command.targetTemperatureLowerCelsius === undefined) {
          state.targetTemperatureLowerCelsius = snapshot.modeProfiles[command.mode]
            ?.targetTemperatureLowerCelsius;
        }
        if (command.targetTemperatureUpperCelsius === undefined) {
          state.targetTemperatureUpperCelsius = snapshot.modeProfiles[command.mode]
            ?.targetTemperatureUpperCelsius;
        }
        if (command.targetTemperatureCelsius !== undefined) {
          state.targetTemperatureCelsius = command.targetTemperatureCelsius;
        }
        if (command.targetTemperatureLowerCelsius !== undefined) {
          state.targetTemperatureLowerCelsius = command.targetTemperatureLowerCelsius;
        }
        if (command.targetTemperatureUpperCelsius !== undefined) {
          state.targetTemperatureUpperCelsius = command.targetTemperatureUpperCelsius;
        }
        break;
      case 'targetTemperature':
        state.targetTemperatureCelsius = command.celsius;
        break;
      case 'automaticTemperatureRange':
        state.targetTemperatureLowerCelsius = command.lowerCelsius;
        state.targetTemperatureUpperCelsius = command.upperCelsius;
        break;
      case 'airflowSpeed':
        state.airflowSpeed = command.speed;
        break;
      case 'submode':
        state.submode = command.submode;
        break;
      case 'temperatureDisplayUnit':
        state.temperatureDisplayUnit = command.unit;
        break;
      }
      snapshot = { ...snapshot, state };
      listener?.(snapshot);
      return { status: 'confirmed', sequence: commands.length };
    },
    stop: () => undefined,
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
    modeProfiles: {},
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
    modeProfiles: {
      cool: { targetTemperatureCelsius: 22, airflowSpeed: 20 },
      heat: { targetTemperatureCelsius: 26, airflowSpeed: 40 },
      auto: {
        targetTemperatureLowerCelsius: 19,
        targetTemperatureUpperCelsius: 24,
        airflowSpeed: 60,
      },
    },
    runtimeTemperatures: {},
    firmwareVersions: { pd: '1.1.0.104' },
    updatedAt: 1,
  };
}

function runtimeSnapshot(
  mode: 'cool' | 'heat',
  targetTemperatureCelsius: number,
  airflowSpeed: number,
  ambientHumidityPercent: number,
): Wave3ControllerSnapshot {
  return {
    availability: 'online',
    state: {
      powered: true,
      mode,
      ambientTemperatureCelsius: mode === 'cool' ? 22 : 23,
      outletTemperatureCelsius: mode === 'cool' ? 16 : 17,
      ambientHumidityPercent,
      targetTemperatureCelsius,
      airflowSpeed,
    },
    modeProfiles: {
      [mode]: { targetTemperatureCelsius, airflowSpeed },
    },
    runtimeTemperatures: {},
    updatedAt: mode === 'cool' ? 1 : 2,
  };
}

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, description = 'Matter runtime state'): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
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
