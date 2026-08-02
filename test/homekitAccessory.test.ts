import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Accessory,
  AccessoryEventTypes,
  Characteristic,
  HAPStatus,
  HapStatusError,
  Service,
  uuid,
  type WithUUID,
} from '@homebridge/hap-nodejs';
import type {
  CharacteristicValue,
  PlatformAccessory,
} from 'homebridge';

import {
  mapSnapshotToHomeKit,
  Wave3PlatformAccessory,
  type Wave3AccessoryController,
} from '../src/platformAccessory.js';
import type {
  EcoFlowWave3Platform,
  Wave3AccessoryContext,
} from '../src/platform.js';
import type {
  Wave3Command,
  Wave3CommandResult,
  Wave3ControllerSnapshot,
} from '../src/wave3/domain.js';

describe('HomeKit climate mapping', () => {
  it('maps confirmed cool, heat, auto, fan, and inactive state', () => {
    const cool = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 25,
      targetTemperatureCelsius: 22,
      airflowSpeed: 60,
    }), Characteristic);
    assert.deepEqual(cool, {
      active: Characteristic.Active.ACTIVE,
      currentState: Characteristic.CurrentHeaterCoolerState.IDLE,
      targetState: Characteristic.TargetHeaterCoolerState.COOL,
      currentTemperature: 25,
      coolingThreshold: 22,
      heatingThreshold: undefined,
      rotationSpeed: 60,
    });

    const heat = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'heat',
    }), Characteristic);
    assert.equal(heat.currentState, Characteristic.CurrentHeaterCoolerState.IDLE);
    assert.equal(heat.targetState, Characteristic.TargetHeaterCoolerState.HEAT);
    assert.equal(heat.coolingThreshold, undefined);

    const autoCooling = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'auto',
      ambientTemperatureCelsius: 28,
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
    }), Characteristic);
    assert.equal(autoCooling.currentState, Characteristic.CurrentHeaterCoolerState.IDLE);
    assert.equal(autoCooling.targetState, Characteristic.TargetHeaterCoolerState.AUTO);
    assert.equal(autoCooling.heatingThreshold, 19);
    assert.equal(autoCooling.coolingThreshold, 24);

    const autoHeating = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'auto',
      ambientTemperatureCelsius: 17,
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
    }), Characteristic);
    assert.equal(autoHeating.currentState, Characteristic.CurrentHeaterCoolerState.IDLE);

    const fan = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'fan',
    }), Characteristic);
    assert.equal(fan.currentState, Characteristic.CurrentHeaterCoolerState.IDLE);
    assert.equal(fan.targetState, undefined);
    assert.equal(fan.coolingThreshold, undefined);
    assert.equal(fan.heatingThreshold, undefined);

    const inactive = mapSnapshotToHomeKit(snapshot({
      powered: false,
      mode: 'off',
    }), Characteristic);
    assert.equal(inactive.active, Characteristic.Active.INACTIVE);
    assert.equal(inactive.currentState, Characteristic.CurrentHeaterCoolerState.INACTIVE);
  });
});

describe('WAVE 3 HomeKit accessory', () => {
  it('maps writes to controller commands and waits for confirmed results', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 25,
      targetTemperatureCelsius: 22,
      airflowSpeed: 60,
    }));
    const accessory = new FakeAccessory('Bedroom WAVE 3', 'uuid-1', 'SERIAL1234');
    const binding = new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    const service = accessory.heaterCooler!;

    await setCharacteristic(service, Characteristic.Active, Characteristic.Active.INACTIVE);
    await setCharacteristic(
      service,
      Characteristic.TargetHeaterCoolerState,
      Characteristic.TargetHeaterCoolerState.HEAT,
    );
    await setCharacteristic(service, Characteristic.HeatingThresholdTemperature, 21);
    await setCharacteristic(service, Characteristic.RotationSpeed, 80);
    assert.deepEqual(controller.commands, [
      { type: 'power', on: false },
      { type: 'mode', mode: 'heat' },
      { type: 'targetTemperature', celsius: 21 },
      { type: 'airflowSpeed', speed: 80 },
    ]);

    controller.emit(snapshot({
      powered: true,
      mode: 'auto',
      targetTemperatureLowerCelsius: 18,
      targetTemperatureUpperCelsius: 25,
    }));
    await Promise.resolve();
    await setCharacteristic(service, Characteristic.CoolingThresholdTemperature, 26);
    await setCharacteristic(service, Characteristic.HeatingThresholdTemperature, 19);
    assert.deepEqual(controller.commands.slice(-2), [
      { type: 'automaticTemperatureRange', lowerCelsius: 18, upperCelsius: 26 },
      { type: 'automaticTemperatureRange', lowerCelsius: 19, upperCelsius: 26 },
    ]);

    controller.nextResult = {
      status: 'failed',
      sequence: 20,
      reason: 'timeout',
    };
    const error = await setCharacteristicError(
      service,
      Characteristic.Active,
      Characteristic.Active.ACTIVE,
    );
    assert.equal(error, HAPStatus.OPERATION_TIMED_OUT);
    binding.stop();
    assert.equal(controller.listenerCount, 0);
  });

  it('serializes state-dependent automatic threshold writes', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'auto',
      ambientTemperatureCelsius: 22,
      targetTemperatureLowerCelsius: 18,
      targetTemperatureUpperCelsius: 25,
      airflowSpeed: 60,
    }));
    const accessory = new FakeAccessory('Bedroom WAVE 3', 'uuid-3', 'SERIAL9012');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    const service = accessory.heaterCooler!;
    const gate = deferred();
    controller.nextGate = gate.promise;

    const cooling = setCharacteristic(
      service,
      Characteristic.CoolingThresholdTemperature,
      26,
    );
    await afterTimeout();
    assert.deepEqual(controller.commands.slice(-1), [
      { type: 'automaticTemperatureRange', lowerCelsius: 18, upperCelsius: 26 },
    ]);
    const heating = setCharacteristic(
      service,
      Characteristic.HeatingThresholdTemperature,
      19,
    );
    await afterTimeout();
    assert.deepEqual(controller.commands.slice(-1), [
      { type: 'automaticTemperatureRange', lowerCelsius: 18, upperCelsius: 26 },
    ]);

    gate.resolve();
    await Promise.all([cooling, heating]);
    assert.deepEqual(controller.commands.slice(-2), [
      { type: 'automaticTemperatureRange', lowerCelsius: 18, upperCelsius: 26 },
      { type: 'automaticTemperatureRange', lowerCelsius: 19, upperCelsius: 26 },
    ]);

    const modeController = new FakeController(snapshot({
      powered: true,
      mode: 'cool',
      targetTemperatureCelsius: 22,
      targetTemperatureLowerCelsius: 18,
      targetTemperatureUpperCelsius: 25,
    }));
    const modeAccessory = new FakeAccessory('Office WAVE 3', 'uuid-5', 'SERIAL7890');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      modeAccessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      modeController,
    );
    const modeService = modeAccessory.heaterCooler!;
    const modeGate = deferred();
    modeController.nextGate = modeGate.promise;
    const selectAuto = setCharacteristic(
      modeService,
      Characteristic.TargetHeaterCoolerState,
      Characteristic.TargetHeaterCoolerState.AUTO,
    );
    await Promise.resolve();
    const setUpper = setCharacteristic(
      modeService,
      Characteristic.CoolingThresholdTemperature,
      24,
    );
    await Promise.resolve();
    assert.deepEqual(modeController.commands, [{ type: 'mode', mode: 'auto' }]);
    modeGate.resolve();
    await Promise.all([selectAuto, setUpper]);
    assert.deepEqual(modeController.commands, [
      { type: 'mode', mode: 'auto' },
      { type: 'automaticTemperatureRange', lowerCelsius: 18, upperCelsius: 24 },
    ]);
  });

  it('coalesces rapid airflow slider writes and suppresses confirmed duplicates', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'cool',
      airflowSpeed: 20,
    }));
    const accessory = new FakeAccessory('Office WAVE 3', 'uuid-airflow', 'SERIALAIR');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    const service = accessory.heaterCooler!;

    const writes = [40, 80, 100].map(speed => setCharacteristic(
      service,
      Characteristic.RotationSpeed,
      speed,
      true,
    ));
    await Promise.all(writes);
    assert.deepEqual(controller.commands, [
      { type: 'airflowSpeed', speed: 100 },
    ]);

    await setCharacteristic(service, Characteristic.RotationSpeed, 100, true);
    assert.equal(controller.commands.length, 1);
  });

  it('coalesces rapid temperature slider writes and suppresses confirmed duplicates', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'cool',
      targetTemperatureCelsius: 20,
    }));
    const accessory = new FakeAccessory('Office WAVE 3', 'uuid-temperature', 'SERIALTEMP');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    const service = accessory.heaterCooler!;

    const writes = [21, 22, 21].map(celsius => setCharacteristic(
      service,
      Characteristic.CoolingThresholdTemperature,
      celsius,
      true,
    ));
    await Promise.all(writes);
    assert.deepEqual(controller.commands, [
      { type: 'targetTemperature', celsius: 21 },
    ]);

    await setCharacteristic(
      service,
      Characteristic.CoolingThresholdTemperature,
      21,
      true,
    );
    assert.equal(controller.commands.length, 1);
  });

  it('advertises upstream-backed WAVE temperature and airflow constraints', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'heat',
      ambientTemperatureCelsius: 20,
      targetTemperatureCelsius: 30,
      airflowSpeed: 100,
    }));
    const accessory = new FakeAccessory('Office WAVE 3', 'uuid-4', 'SERIAL3456');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    const service = accessory.heaterCooler!;
    const heating = service.getCharacteristic(Characteristic.HeatingThresholdTemperature);
    const cooling = service.getCharacteristic(Characteristic.CoolingThresholdTemperature);
    const rotation = service.getCharacteristic(Characteristic.RotationSpeed);
    assert.deepEqual(
      pickRange(heating.props),
      { minValue: 16, maxValue: 30, minStep: 0.1 },
    );
    assert.deepEqual(
      pickRange(cooling.props),
      { minValue: 16, maxValue: 30, minStep: 0.1 },
    );
    assert.deepEqual(
      pickRange(rotation.props),
      { minValue: 20, maxValue: 100, minStep: 20 },
    );
    assert.equal(heating.value, 30);

    await setCharacteristic(
      service,
      Characteristic.HeatingThresholdTemperature,
      30,
      true,
    );
    const invalidTemperature = await setCharacteristicError(
      service,
      Characteristic.CoolingThresholdTemperature,
      15,
      true,
    );
    assert.equal(invalidTemperature, HAPStatus.INVALID_VALUE_IN_REQUEST);
    await setCharacteristic(
      service,
      Characteristic.HeatingThresholdTemperature,
      20.8,
      true,
    );
    const invalidFraction = await setCharacteristicError(
      service,
      Characteristic.HeatingThresholdTemperature,
      22.55,
      true,
    );
    assert.equal(invalidFraction, HAPStatus.INVALID_VALUE_IN_REQUEST);

    const invalidAirflow = await setCharacteristicError(
      service,
      Characteristic.RotationSpeed,
      21,
      true,
    );
    assert.equal(invalidAirflow, HAPStatus.INVALID_VALUE_IN_REQUEST);
    assert.deepEqual(controller.commands.slice(-1), [
      { type: 'targetTemperature', celsius: 20.8 },
    ]);
  });

  it('reconciles restored HAP names without characteristic-range warnings', () => {
    const accessory = new Accessory(
      'Configured WAVE 3',
      uuid.generate('restored-wave3-name'),
    );
    Object.assign(accessory, {
      context: {
        schemaVersion: 1,
        serialNumber: 'SERIALRESTORED',
      } satisfies Wave3AccessoryContext,
    });
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Name, 'Old Accessory Name');
    const heaterCooler = accessory.addService(Service.HeaterCooler, 'Old Service Name');
    heaterCooler.setCharacteristic(Characteristic.Name, 'Old Service Name');
    const warnings: unknown[] = [];
    accessory.on(AccessoryEventTypes.CHARACTERISTIC_WARNING, warning => {
      warnings.push(warning);
    });
    const consoleWarnings: unknown[][] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...values: unknown[]) => {
      consoleWarnings.push(values);
    };
    try {
      new Wave3PlatformAccessory(
        platformForAccessoryTests(),
        accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
        new FakeController(snapshot({
          powered: true,
          mode: 'heat',
          targetTemperatureCelsius: 30,
          airflowSpeed: 100,
        })),
      );
      (accessory as unknown as {
        validateAccessory(mainAccessory?: boolean): void;
      }).validateAccessory(false);
    } finally {
      console.warn = originalConsoleWarn;
    }

    assert.equal(
      accessory.getService(Service.AccessoryInformation)!
        .getCharacteristic(Characteristic.Name).value,
      'Configured WAVE 3',
    );
    assert.equal(
      heaterCooler.getCharacteristic(Characteristic.Name).value,
      'Configured WAVE 3',
    );
    assert.deepEqual(warnings, []);
    assert.deepEqual(consoleWarnings, []);
  });

  it('rejects thresholds outside their confirmed operating mode and recovers the write queue', async () => {
    const cases: Array<{
      mode: Wave3ControllerSnapshot['state']['mode'];
      characteristic: typeof Characteristic.HeatingThresholdTemperature
        | typeof Characteristic.CoolingThresholdTemperature;
    }> = [
      { mode: 'cool', characteristic: Characteristic.HeatingThresholdTemperature },
      { mode: 'heat', characteristic: Characteristic.CoolingThresholdTemperature },
      { mode: 'fan', characteristic: Characteristic.HeatingThresholdTemperature },
      { mode: 'dry', characteristic: Characteristic.CoolingThresholdTemperature },
      { mode: 'off', characteristic: Characteristic.HeatingThresholdTemperature },
      { mode: undefined, characteristic: Characteristic.CoolingThresholdTemperature },
    ];
    for (const [index, testCase] of cases.entries()) {
      const controller = new FakeController(snapshot({
        powered: testCase.mode !== 'off',
        ...(testCase.mode === undefined ? {} : { mode: testCase.mode }),
        targetTemperatureCelsius: 22,
      }));
      const accessory = new FakeAccessory(
        `Test WAVE 3 ${index}`,
        `uuid-mode-${index}`,
        `SERIALMODE${index}`,
      );
      new Wave3PlatformAccessory(
        platformForAccessoryTests(),
        accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
        controller,
      );
      const error = await setCharacteristicError(
        accessory.heaterCooler!,
        testCase.characteristic,
        23,
        true,
      );
      assert.equal(error, HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      assert.deepEqual(controller.commands, []);
    }

    const incompleteAuto = new FakeController(snapshot({
      powered: true,
      mode: 'auto',
      targetTemperatureUpperCelsius: 25,
    }));
    const autoAccessory = new FakeAccessory('Auto WAVE 3', 'uuid-auto', 'SERIALAUTO');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      autoAccessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      incompleteAuto,
    );
    const incompleteError = await setCharacteristicError(
      autoAccessory.heaterCooler!,
      Characteristic.CoolingThresholdTemperature,
      24,
      true,
    );
    assert.equal(incompleteError, HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);

    incompleteAuto.emit(snapshot({
      powered: true,
      mode: 'cool',
      targetTemperatureCelsius: 22,
    }));
    await setCharacteristic(
      autoAccessory.heaterCooler!,
      Characteristic.CoolingThresholdTemperature,
      23,
      true,
    );
    assert.deepEqual(incompleteAuto.commands, [
      { type: 'targetTemperature', celsius: 23 },
    ]);
  });

  it('uses idle for unknown activity, preserves an evidenced inactive target, and rejects unsupported targets', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 18,
      targetTemperatureCelsius: 22,
    }));
    const accessory = new FakeAccessory('Bedroom WAVE 3', 'uuid-state', 'SERIALSTATE');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    assert.equal(
      await getCharacteristic(
        accessory.heaterCooler!,
        Characteristic.CurrentHeaterCoolerState,
      ),
      Characteristic.CurrentHeaterCoolerState.IDLE,
    );
    assert.equal(accessory.context.lastTargetMode, 'cool');

    controller.emit(snapshot({ powered: false, mode: 'off' }));
    await Promise.resolve();
    assert.equal(
      await getCharacteristic(
        accessory.heaterCooler!,
        Characteristic.TargetHeaterCoolerState,
      ),
      Characteristic.TargetHeaterCoolerState.COOL,
    );

    controller.emit(snapshot({ powered: true, mode: 'fan' }));
    await Promise.resolve();
    const targetError = await getCharacteristicError(
      accessory.heaterCooler!,
      Characteristic.TargetHeaterCoolerState,
    );
    assert.equal(targetError, HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('reconciles a newer confirmed snapshot after HAP completes an older write', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'cool',
      targetTemperatureCelsius: 20,
    }));
    const accessory = new FakeAccessory('Office WAVE 3', 'uuid-race', 'SERIALRACE');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    controller.afterApply = current => {
      current.emit(snapshot({
        powered: true,
        mode: 'cool',
        targetTemperatureCelsius: 22,
      }));
    };

    await setCharacteristic(
      accessory.heaterCooler!,
      Characteristic.CoolingThresholdTemperature,
      21,
      true,
    );
    await afterImmediate();
    assert.equal(controller.snapshot.state.targetTemperatureCelsius, 22);
    assert.equal(
      accessory.heaterCooler!
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .value,
      22,
    );
  });

  it('pushes snapshots asynchronously and reports offline or missing state as HAP errors', async () => {
    const controller = new FakeController(snapshot({
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 24,
      targetTemperatureCelsius: 20,
      airflowSpeed: 40,
    }));
    const accessory = new FakeAccessory('Office WAVE 3', 'uuid-2', 'SERIAL5678');
    new Wave3PlatformAccessory(
      platformForAccessoryTests(),
      accessory as unknown as PlatformAccessory<Wave3AccessoryContext>,
      controller,
    );
    const service = accessory.heaterCooler!;

    assert.equal(
      await getCharacteristic(service, Characteristic.CurrentTemperature),
      24,
    );
    controller.emit(snapshot({
      powered: true,
      mode: 'heat',
      ambientTemperatureCelsius: 18,
      targetTemperatureCelsius: 23,
      airflowSpeed: 100,
    }));
    await Promise.resolve();
    assert.equal(
      service.getCharacteristic(Characteristic.CurrentTemperature).value,
      18,
    );
    assert.equal(
      service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
      Characteristic.CurrentHeaterCoolerState.IDLE,
    );

    controller.emit({
      availability: 'stale',
      state: controller.snapshot.state,
      runtimeTemperatures: {},
    });
    await Promise.resolve();
    const staleError = await getCharacteristicError(
      service,
      Characteristic.CurrentTemperature,
    );
    assert.equal(staleError, HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    controller.emit(snapshot({ powered: true, mode: 'cool' }));
    await Promise.resolve();
    const missingError = await getCharacteristicError(
      service,
      Characteristic.CurrentTemperature,
    );
    assert.equal(missingError, HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });
});

class FakeController implements Wave3AccessoryController {
  readonly commands: Wave3Command[] = [];
  private readonly listeners = new Set<(snapshot: Wave3ControllerSnapshot) => void>();
  nextResult: Wave3CommandResult = { status: 'confirmed', sequence: 10 };
  nextGate?: Promise<void>;
  afterApply?: (controller: FakeController) => void;
  stopped = false;

  constructor(public snapshot: Wave3ControllerSnapshot) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  onSnapshot(listener: (snapshot: Wave3ControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(command: Wave3Command): Promise<Wave3CommandResult> {
    this.commands.push(command);
    const gate = this.nextGate;
    this.nextGate = undefined;
    await gate;
    if (this.nextResult.status === 'confirmed') {
      this.applyConfirmedCommand(command);
      const afterApply = this.afterApply;
      this.afterApply = undefined;
      afterApply?.(this);
    }
    return this.nextResult;
  }

  stop(): void {
    this.stopped = true;
  }

  emit(value: Wave3ControllerSnapshot): void {
    this.snapshot = value;
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  private applyConfirmedCommand(command: Wave3Command): void {
    const state = { ...this.snapshot.state };
    switch (command.type) {
    case 'power':
      state.powered = command.on;
      break;
    case 'mode':
      state.powered = true;
      state.mode = command.mode;
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
    this.emit({ ...this.snapshot, state });
  }
}

class FakeAccessory {
  readonly context: Wave3AccessoryContext;
  private readonly information = new Service.AccessoryInformation();
  heaterCooler?: Service;

  constructor(
    public displayName: string,
    public readonly UUID: string,
    serialNumber: string,
  ) {
    this.context = { schemaVersion: 1, serialNumber };
  }

  getService(service: typeof Service.AccessoryInformation | typeof Service.HeaterCooler): Service | undefined {
    if (service === Service.AccessoryInformation) {
      return this.information;
    }
    return this.heaterCooler;
  }

  addService(
    service: typeof Service.HeaterCooler,
    displayName: string,
  ): Service {
    this.heaterCooler = new service(displayName);
    return this.heaterCooler;
  }
}

function platformForAccessoryTests(): EcoFlowWave3Platform {
  return {
    Service,
    Characteristic,
    homeKitWriteSettleMilliseconds: 1,
    log: {
      info: () => undefined,
    },
    api: {
      hap: {
        HAPStatus: {
          SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          INVALID_VALUE_IN_REQUEST: HAPStatus.INVALID_VALUE_IN_REQUEST,
          OPERATION_TIMED_OUT: HAPStatus.OPERATION_TIMED_OUT,
          NOT_ALLOWED_IN_CURRENT_STATE: HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
        },
        HapStatusError,
      },
      updatePlatformAccessories: () => undefined,
    },
  } as unknown as EcoFlowWave3Platform;
}

function snapshot(
  state: Wave3ControllerSnapshot['state'],
): Wave3ControllerSnapshot {
  return {
    availability: 'online',
    state,
    runtimeTemperatures: {},
    updatedAt: 1,
  };
}

async function getCharacteristic(
  service: Service,
  characteristic: WithUUID<new () => Characteristic>,
): Promise<CharacteristicValue | null> {
  return service.getCharacteristic(characteristic).handleGetRequest();
}

async function getCharacteristicError(
  service: Service,
  characteristic: WithUUID<new () => Characteristic>,
): Promise<Error> {
  try {
    await getCharacteristic(service, characteristic);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected characteristic read to fail');
}

async function setCharacteristic(
  service: Service,
  characteristic: WithUUID<new () => Characteristic>,
  value: CharacteristicValue,
  asClient = false,
): Promise<void> {
  await service.getCharacteristic(characteristic).handleSetRequest(
    value,
    asClient ? {} as never : undefined,
  );
}

async function setCharacteristicError(
  service: Service,
  characteristic: WithUUID<new () => Characteristic>,
  value: CharacteristicValue,
  asClient = false,
): Promise<unknown> {
  try {
    await setCharacteristic(service, characteristic, value, asClient);
  } catch (error) {
    return error;
  }
  throw new Error('expected characteristic write to fail');
}

function pickRange(props: Characteristic['props']): {
  minValue?: number;
  maxValue?: number;
  minStep?: number;
} {
  return {
    minValue: props.minValue,
    maxValue: props.maxValue,
    minStep: props.minStep,
  };
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

async function afterImmediate(): Promise<void> {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

async function afterTimeout(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 5);
  });
}
