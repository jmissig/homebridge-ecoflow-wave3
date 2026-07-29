import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type {
  Wave3Command,
  Wave3CommandResult,
  Wave3ControllerSnapshot,
  Wave3State,
} from './wave3/domain.js';
import type {
  EcoFlowWave3Platform,
  Wave3AccessoryContext,
} from './platform.js';

export interface Wave3AccessoryController {
  readonly snapshot: Wave3ControllerSnapshot;
  onSnapshot(listener: (snapshot: Wave3ControllerSnapshot) => void): () => void;
  execute(command: Wave3Command): Promise<Wave3CommandResult>;
  stop(): void;
}

type HomeKitClimateKey =
  | 'active'
  | 'currentState'
  | 'targetState'
  | 'currentTemperature'
  | 'coolingThreshold'
  | 'heatingThreshold'
  | 'rotationSpeed';

type CharacteristicType = Exclude<Parameters<Service['getCharacteristic']>[0], string>;

interface HomeKitClimateValues {
  active?: number;
  currentState?: number;
  targetState?: number;
  currentTemperature?: number;
  coolingThreshold?: number;
  heatingThreshold?: number;
  rotationSpeed?: number;
}

/**
 * HomeKit presentation boundary for one EcoFlow WAVE 3.
 */
export class Wave3PlatformAccessory {
  public readonly heaterCoolerService: Service;

  private snapshot: Wave3ControllerSnapshot;
  private readonly detachSnapshot: () => void;
  private stopped = false;

  constructor(
    private readonly platform: EcoFlowWave3Platform,
    private readonly accessory: PlatformAccessory<Wave3AccessoryContext>,
    private readonly controller: Wave3AccessoryController,
  ) {
    this.snapshot = controller.snapshot;
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'EcoFlow')
      .setCharacteristic(this.platform.Characteristic.Model, 'WAVE 3')
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        accessory.context.serialNumber,
      );

    this.heaterCoolerService = this.accessory.getService(this.platform.Service.HeaterCooler)
      ?? this.accessory.addService(
        this.platform.Service.HeaterCooler,
        this.accessory.displayName,
      );

    this.bindCharacteristics();
    this.detachSnapshot = controller.onSnapshot(snapshot => {
      this.snapshot = snapshot;
      queueMicrotask(() => {
        if (!this.stopped) {
          this.pushSnapshot(snapshot);
        }
      });
    });
    this.pushSnapshot(this.snapshot);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.detachSnapshot();
  }

  private bindCharacteristics(): void {
    const characteristic = this.platform.Characteristic;

    this.bind(
      characteristic.Active,
      'active',
      value => {
        if (value === characteristic.Active.ACTIVE) {
          return { type: 'power', on: true };
        }
        if (value === characteristic.Active.INACTIVE) {
          return { type: 'power', on: false };
        }
        throw new RangeError('unsupported active state');
      },
    );
    this.bind(
      characteristic.TargetHeaterCoolerState,
      'targetState',
      value => targetStateCommand(Number(value), characteristic.TargetHeaterCoolerState),
    );
    this.bind(
      characteristic.CoolingThresholdTemperature,
      'coolingThreshold',
      value => thresholdCommand('cooling', Number(value), this.snapshot.state),
    );
    this.bind(
      characteristic.HeatingThresholdTemperature,
      'heatingThreshold',
      value => thresholdCommand('heating', Number(value), this.snapshot.state),
    );
    this.bind(
      characteristic.RotationSpeed,
      'rotationSpeed',
      value => ({ type: 'airflowSpeed', speed: airflowSpeed(Number(value)) }),
    );
    this.heaterCoolerService
      .getCharacteristic(characteristic.RotationSpeed)
      .setProps({ minValue: 20, maxValue: 100, minStep: 20 });

    this.bindReadOnly(characteristic.CurrentHeaterCoolerState, 'currentState');
    this.bindReadOnly(characteristic.CurrentTemperature, 'currentTemperature');
  }

  private bind(
    characteristicType: CharacteristicType,
    key: HomeKitClimateKey,
    command: (value: CharacteristicValue) => Wave3Command,
  ): void {
    this.heaterCoolerService
      .getCharacteristic(characteristicType)
      .onGet(() => this.readCharacteristic(key))
      .onSet(async value => {
        this.requireOnline();
        let requestedCommand: Wave3Command;
        try {
          requestedCommand = command(value);
        } catch {
          throw this.invalidValueError();
        }
        const result = await this.controller.execute(requestedCommand);
        if (result.status === 'failed') {
          throw this.commandError(result);
        }
      });
  }

  private bindReadOnly(
    characteristicType: CharacteristicType,
    key: HomeKitClimateKey,
  ): void {
    this.heaterCoolerService
      .getCharacteristic(characteristicType)
      .onGet(() => this.readCharacteristic(key));
  }

  private readCharacteristic(key: HomeKitClimateKey): CharacteristicValue {
    this.requireOnline();
    const value = mapSnapshotToHomeKit(
      this.snapshot,
      this.platform.Characteristic,
    )[key];
    if (value === undefined) {
      throw this.communicationError();
    }
    return value;
  }

  private pushSnapshot(snapshot: Wave3ControllerSnapshot): void {
    if (snapshot.availability !== 'online') {
      const error = this.communicationError();
      for (const characteristicType of this.climateCharacteristics()) {
        this.heaterCoolerService.updateCharacteristic(characteristicType, error);
      }
      return;
    }

    const values = mapSnapshotToHomeKit(snapshot, this.platform.Characteristic);
    const characteristic = this.platform.Characteristic;
    const mappings = [
      [characteristic.Active, values.active],
      [characteristic.CurrentHeaterCoolerState, values.currentState],
      [characteristic.TargetHeaterCoolerState, values.targetState],
      [characteristic.CurrentTemperature, values.currentTemperature],
      [characteristic.CoolingThresholdTemperature, values.coolingThreshold],
      [characteristic.HeatingThresholdTemperature, values.heatingThreshold],
      [characteristic.RotationSpeed, values.rotationSpeed],
    ] as const;
    for (const [characteristicType, value] of mappings) {
      if (value === undefined) {
        this.heaterCoolerService.updateCharacteristic(
          characteristicType,
          this.communicationError(),
        );
      } else {
        this.heaterCoolerService.updateCharacteristic(characteristicType, value);
      }
    }
  }

  private climateCharacteristics(): CharacteristicType[] {
    const characteristic = this.platform.Characteristic;
    return [
      characteristic.Active,
      characteristic.CurrentHeaterCoolerState,
      characteristic.TargetHeaterCoolerState,
      characteristic.CurrentTemperature,
      characteristic.CoolingThresholdTemperature,
      characteristic.HeatingThresholdTemperature,
      characteristic.RotationSpeed,
    ];
  }

  private requireOnline(): void {
    if (this.snapshot.availability !== 'online') {
      throw this.communicationError();
    }
  }

  private communicationError(): Error {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  private invalidValueError(): Error {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST,
    );
  }

  private commandError(result: Extract<Wave3CommandResult, { status: 'failed' }>): Error {
    const status = result.reason === 'timeout'
      ? this.platform.api.hap.HAPStatus.OPERATION_TIMED_OUT
      : result.reason === 'stopped'
        ? this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
        : this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
    return new this.platform.api.hap.HapStatusError(status);
  }
}

export function mapSnapshotToHomeKit(
  snapshot: Wave3ControllerSnapshot,
  characteristic: EcoFlowWave3Platform['Characteristic'],
): HomeKitClimateValues {
  const state = snapshot.state;
  const active = state.powered === undefined
    ? undefined
    : state.powered
      ? characteristic.Active.ACTIVE
      : characteristic.Active.INACTIVE;
  const targetState = targetHomeKitState(state.mode, characteristic.TargetHeaterCoolerState);
  return {
    active,
    currentState: currentHomeKitState(state, characteristic.CurrentHeaterCoolerState),
    targetState,
    currentTemperature: state.ambientTemperatureCelsius,
    coolingThreshold: state.mode === 'auto'
      ? state.targetTemperatureUpperCelsius
      : state.targetTemperatureCelsius,
    heatingThreshold: state.mode === 'auto'
      ? state.targetTemperatureLowerCelsius
      : state.targetTemperatureCelsius,
    rotationSpeed: isAirflowSpeed(state.airflowSpeed)
      ? state.airflowSpeed
      : undefined,
  };
}

function currentHomeKitState(
  state: Readonly<Wave3State>,
  values: EcoFlowWave3Platform['Characteristic']['CurrentHeaterCoolerState'],
): number | undefined {
  if (state.powered === false) {
    return values.INACTIVE;
  }
  if (state.powered !== true || state.mode === undefined) {
    return undefined;
  }
  if (state.mode === 'cool' || state.mode === 'dry') {
    return values.COOLING;
  }
  if (state.mode === 'heat') {
    return values.HEATING;
  }
  if (state.mode === 'auto') {
    const ambient = state.ambientTemperatureCelsius;
    if (ambient !== undefined
      && state.targetTemperatureUpperCelsius !== undefined
      && ambient > state.targetTemperatureUpperCelsius) {
      return values.COOLING;
    }
    if (ambient !== undefined
      && state.targetTemperatureLowerCelsius !== undefined
      && ambient < state.targetTemperatureLowerCelsius) {
      return values.HEATING;
    }
  }
  return values.IDLE;
}

function targetHomeKitState(
  mode: Wave3State['mode'],
  values: EcoFlowWave3Platform['Characteristic']['TargetHeaterCoolerState'],
): number | undefined {
  switch (mode) {
  case 'cool':
  case 'dry':
    return values.COOL;
  case 'heat':
    return values.HEAT;
  case 'auto':
  case 'fan':
    return values.AUTO;
  case 'off':
    return values.AUTO;
  case undefined:
    return undefined;
  }
}

function targetStateCommand(
  value: number,
  values: EcoFlowWave3Platform['Characteristic']['TargetHeaterCoolerState'],
): Wave3Command {
  if (value === values.AUTO) {
    return { type: 'mode', mode: 'auto' };
  }
  if (value === values.COOL) {
    return { type: 'mode', mode: 'cool' };
  }
  if (value === values.HEAT) {
    return { type: 'mode', mode: 'heat' };
  }
  throw new RangeError('unsupported target heater/cooler state');
}

function thresholdCommand(
  kind: 'cooling' | 'heating',
  celsius: number,
  state: Readonly<Wave3State>,
): Wave3Command {
  validateTemperature(celsius);
  if (state.mode !== 'auto') {
    return { type: 'targetTemperature', celsius };
  }
  const other = kind === 'cooling'
    ? state.targetTemperatureLowerCelsius
    : state.targetTemperatureUpperCelsius;
  if (other === undefined) {
    throw new RangeError('automatic temperature range is incomplete');
  }
  const lowerCelsius = kind === 'heating' ? celsius : other;
  const upperCelsius = kind === 'cooling' ? celsius : other;
  if (lowerCelsius > upperCelsius) {
    throw new RangeError('automatic temperature range is invalid');
  }
  return { type: 'automaticTemperatureRange', lowerCelsius, upperCelsius };
}

function validateTemperature(celsius: number): void {
  if (!Number.isFinite(celsius) || celsius < 16 || celsius > 30) {
    throw new RangeError('temperature must be from 16 through 30 degrees Celsius');
  }
}

function airflowSpeed(value: number): 20 | 40 | 60 | 80 | 100 {
  if (!Number.isFinite(value)) {
    throw new RangeError('airflow speed must be numeric');
  }
  const rounded = Math.round(value / 20) * 20;
  if (rounded !== 20 && rounded !== 40 && rounded !== 60 && rounded !== 80 && rounded !== 100) {
    throw new RangeError('airflow speed is out of range');
  }
  return rounded;
}

function isAirflowSpeed(value: number | undefined): value is 20 | 40 | 60 | 80 | 100 {
  return value === 20
    || value === 40
    || value === 60
    || value === 80
    || value === 100;
}
