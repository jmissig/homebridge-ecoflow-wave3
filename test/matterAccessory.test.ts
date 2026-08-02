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
import type {
  Wave3Command,
  Wave3CommandFailure,
  Wave3ControllerSnapshot,
} from '../src/wave3/domain.js';

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
      assert.equal(endpoint.state.onOff.onOff, true);
      assert.equal(endpoint.state.thermostat.systemMode, MATTER_SYSTEM_MODE.auto);
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
          wave3RoomAirConditionerDeviceType(source).with(BridgedDeviceBasicInformationServer),
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
            occupiedCoolingSetpoint: number;
            occupiedHeatingSetpoint: number;
            minSetpointDeadBand: number;
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
        assert.equal(endpointState().thermostat.minSetpointDeadBand, 0);
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
        wave3RoomAirConditionerDeviceType('ambient').with(BridgedDeviceBasicInformationServer),
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
      const runtimeMatter = {
        ...baseMatter,
        updateAccessoryState: async (
          _uuid: string,
          cluster: string,
          attributes: Record<string, unknown>,
        ) => {
          await stateUpdateGate?.promise;
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
        { error: message => errors.push(message) },
      );
      const directControl = (binding as unknown as {
        createMatterControl(): {
          setPower(on: boolean, applyMatter: () => Promise<void>): Promise<void>;
          setHeatingSetpoint(value: number): void;
          setCoolingSetpoint(value: number): void;
          raiseLowerSetpoint(
            mode: number,
            amount: number,
            applyMatter: () => Promise<void>,
          ): Promise<void>;
        };
      }).createMatterControl();

      await endpoint.act('turn off', agent => agent.onOff.off());
      await endpoint.act('turn on', agent => agent.onOff.on());
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
        [MATTER_SYSTEM_MODE.auto, { type: 'mode', mode: 'auto' }],
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
        await waitUntil(() => endpoint.state.thermostat.systemMode === systemMode);
      }

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'baseline automatic range',
      );
      const heatingCrossingBefore = controller.commands.length;
      await endpoint.set({ thermostat: { occupiedHeatingSetpoint: 2_500 } });
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureLowerCelsius === 25
          && controller.snapshot.state.targetTemperatureUpperCelsius === 25
          && endpoint.state.thermostat.occupiedHeatingSetpoint === 2_500
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_500,
        'crossing heating setpoint and companion cooling setpoint',
      );
      assert.deepEqual(controller.commands.slice(heatingCrossingBefore), [{
        type: 'automaticTemperatureRange',
        lowerCelsius: 25,
        upperCelsius: 25,
      }]);
      const coolingCrossingBefore = controller.commands.length;
      await endpoint.set({ thermostat: { occupiedCoolingSetpoint: 1_800 } });
      await waitUntil(
        () => controller.snapshot.state.targetTemperatureLowerCelsius === 18
          && controller.snapshot.state.targetTemperatureUpperCelsius === 18
          && endpoint.state.thermostat.occupiedHeatingSetpoint === 1_800
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 1_800,
        'crossing cooling setpoint and companion heating setpoint',
      );
      assert.deepEqual(controller.commands.slice(coolingCrossingBefore), [{
        type: 'automaticTemperatureRange',
        lowerCelsius: 18,
        upperCelsius: 18,
      }]);

      controller.setSnapshot(onlineSnapshot());
      await waitUntil(
        () => endpoint.state.thermostat.occupiedHeatingSetpoint === 1_900
          && endpoint.state.thermostat.occupiedCoolingSetpoint === 2_400,
        'restored automatic range',
      );
      await endpoint.set({ thermostat: { occupiedHeatingSetpoint: 2_000 } });
      await waitUntil(() => controller.commands.at(-1)?.type === 'automaticTemperatureRange'
        && controller.snapshot.state.targetTemperatureLowerCelsius === 20);
      await endpoint.set({ thermostat: { occupiedCoolingSetpoint: 2_500 } });
      await waitUntil(() => controller.snapshot.state.targetTemperatureUpperCelsius === 25);
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
      assert.equal(endpoint.state.fanControl.fanMode, 2);
      assert.equal(endpoint.state.fanControl.percentSetting, 40);
      assert.equal(endpoint.state.fanControl.speedSetting, 2);
      await endpoint.set({ fanControl: { percentSetting: 80 } });
      assert.equal(endpoint.state.fanControl.fanMode, 3);
      assert.equal(endpoint.state.fanControl.percentSetting, 80);
      assert.equal(endpoint.state.fanControl.speedSetting, 4);
      await new Promise<void>(resolve => setTimeout(resolve, 800));
      assert.equal(
        controller.commands.filter(command => command.type === 'airflowSpeed').length,
        airflowBeforeReturnToConfirmed,
      );
      assert.deepEqual(controller.commands.slice(0, 2), [
        { type: 'power', on: false },
        { type: 'power', on: true },
      ]);

      await assert.rejects(
        endpoint.set({ fanControl: { percentSetting: 0 } }),
        /power control to turn off/,
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
        'raise/lower baseline range',
      );
      await endpoint.act('raise heat across cool', agent => agent.thermostat.setpointRaiseLower({
        mode: 0,
        amount: 60,
      }));
      assert.deepEqual(controller.commands.at(-1), {
        type: 'automaticTemperatureRange',
        lowerCelsius: 25,
        upperCelsius: 25,
      });
      assert.equal(endpoint.state.thermostat.occupiedHeatingSetpoint, 2_500);
      assert.equal(endpoint.state.thermostat.occupiedCoolingSetpoint, 2_500);

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
        lowerCelsius: 18,
        upperCelsius: 18,
      });
      assert.equal(endpoint.state.thermostat.occupiedHeatingSetpoint, 1_800);
      assert.equal(endpoint.state.thermostat.occupiedCoolingSetpoint, 1_800);

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
          upperCelsius: 24,
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

      controller.failNext('disconnected');
      await assert.rejects(
        async () => endpoint.act('failed power command', agent => agent.onOff.off()),
        /not currently controllable/,
      );
      assert.equal(endpoint.state.onOff.onOff, true);

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

      controller.failNext('timeout');
      await endpoint.set({ thermostat: { systemMode: MATTER_SYSTEM_MODE.cool } });
      await waitUntil(() => errors.length === 2, 'failed attribute command reconciliation');
      await waitUntil(
        () => endpoint.state.thermostat.systemMode === MATTER_SYSTEM_MODE.auto,
        'confirmed thermostat restoration',
      );
      assert.match(errors[1]!, /did not confirm the command/);

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
      'EcoFlow WAVE 3 Matter power command failed: '
        + 'EcoFlow WAVE 3 is not currently controllable',
      'EcoFlow WAVE 3 Matter system mode command failed: '
        + 'EcoFlow WAVE 3 did not confirm the command',
    ]);
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
      absMinHeatSetpointLimit: 1_600,
      minHeatSetpointLimit: 1_600,
      maxHeatSetpointLimit: 3_000,
      absMaxHeatSetpointLimit: 3_000,
      absMinCoolSetpointLimit: 1_600,
      minCoolSetpointLimit: 1_600,
      maxCoolSetpointLimit: 3_000,
      absMaxCoolSetpointLimit: 3_000,
      minSetpointDeadBand: 0,
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

    await binding.stop();
    controller.emit(onlineSnapshot());
    await drainMicrotasks();
    assert.equal(harness.stateUpdates.length, 5);
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
  failNext(reason: Wave3CommandFailure): void;
  setSnapshot(snapshot: Wave3ControllerSnapshot): void;
} {
  let snapshot = initial;
  let listener: ((snapshot: Wave3ControllerSnapshot) => void) | undefined;
  const commands: Wave3Command[] = [];
  let nextFailure: Wave3CommandFailure | undefined;
  return {
    get snapshot() {
      return snapshot;
    },
    commands,
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
    runtimeTemperatures: {},
    updatedAt: mode === 'cool' ? 1 : 2,
  };
}

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, description = 'Matter runtime state'): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
