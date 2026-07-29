import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Characteristic,
  HAPStatus,
  HapStatusError,
  Service,
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
      currentState: Characteristic.CurrentHeaterCoolerState.COOLING,
      targetState: Characteristic.TargetHeaterCoolerState.COOL,
      currentTemperature: 25,
      coolingThreshold: 22,
      heatingThreshold: 22,
      rotationSpeed: 60,
    });

    const heat = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'heat',
    }), Characteristic);
    assert.equal(heat.currentState, Characteristic.CurrentHeaterCoolerState.HEATING);
    assert.equal(heat.targetState, Characteristic.TargetHeaterCoolerState.HEAT);

    const autoCooling = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'auto',
      ambientTemperatureCelsius: 28,
      targetTemperatureLowerCelsius: 19,
      targetTemperatureUpperCelsius: 24,
    }), Characteristic);
    assert.equal(autoCooling.currentState, Characteristic.CurrentHeaterCoolerState.COOLING);
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
    assert.equal(autoHeating.currentState, Characteristic.CurrentHeaterCoolerState.HEATING);

    const fan = mapSnapshotToHomeKit(snapshot({
      powered: true,
      mode: 'fan',
    }), Characteristic);
    assert.equal(fan.currentState, Characteristic.CurrentHeaterCoolerState.IDLE);
    assert.equal(fan.targetState, Characteristic.TargetHeaterCoolerState.AUTO);

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
    await setCharacteristic(service, Characteristic.CoolingThresholdTemperature, 21);
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
      { type: 'automaticTemperatureRange', lowerCelsius: 19, upperCelsius: 25 },
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
      Characteristic.CurrentHeaterCoolerState.HEATING,
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
): Promise<void> {
  await service.getCharacteristic(characteristic).handleSetRequest(value);
}

async function setCharacteristicError(
  service: Service,
  characteristic: WithUUID<new () => Characteristic>,
  value: CharacteristicValue,
): Promise<unknown> {
  try {
    await setCharacteristic(service, characteristic, value);
  } catch (error) {
    return error;
  }
  throw new Error('expected characteristic write to fail');
}
