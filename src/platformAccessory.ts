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

interface PendingAirflowWrite {
  speed: 20 | 40 | 60 | 80 | 100;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

const AIRFLOW_SETTLE_MILLISECONDS = 750;

/**
 * HomeKit presentation boundary for one EcoFlow WAVE 3.
 */
export class Wave3PlatformAccessory {
  public readonly heaterCoolerService: Service;

  private snapshot: Wave3ControllerSnapshot;
  private readonly detachSnapshot: () => void;
  private writeTail: Promise<void> = Promise.resolve();
  private pendingAirflowWrite?: PendingAirflowWrite;
  private lastTargetState?: number;
  private stopped = false;

  constructor(
    private readonly platform: EcoFlowWave3Platform,
    private readonly accessory: PlatformAccessory<Wave3AccessoryContext>,
    private readonly controller: Wave3AccessoryController,
  ) {
    this.snapshot = controller.snapshot;
    this.lastTargetState = targetStateForMode(
      accessory.context.lastTargetMode,
      this.platform.Characteristic.TargetHeaterCoolerState,
    );
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Name,
        this.accessory.displayName,
      )
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
    this.heaterCoolerService.setCharacteristic(
      this.platform.Characteristic.Name,
      this.accessory.displayName,
    );

    this.configureWritableRanges();
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
    if (this.pendingAirflowWrite !== undefined) {
      if (this.pendingAirflowWrite.timer !== undefined) {
        clearTimeout(this.pendingAirflowWrite.timer);
      }
      const error = this.communicationError();
      for (const waiter of this.pendingAirflowWrite.waiters) {
        waiter.reject(error);
      }
      this.pendingAirflowWrite = undefined;
    }
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
    this.bindAirflowSpeed(characteristic.RotationSpeed);
    this.bindReadOnly(characteristic.CurrentHeaterCoolerState, 'currentState');
    this.bindReadOnly(characteristic.CurrentTemperature, 'currentTemperature');
  }

  private configureWritableRanges(): void {
    const characteristic = this.platform.Characteristic;
    for (const threshold of [
      characteristic.CoolingThresholdTemperature,
      characteristic.HeatingThresholdTemperature,
    ]) {
      const instance = this.heaterCoolerService.getCharacteristic(threshold);
      instance.updateValue(16);
      instance.setProps({ minValue: 16, maxValue: 30, minStep: 0.1 });
    }
    const rotationSpeed = this.heaterCoolerService
      .getCharacteristic(characteristic.RotationSpeed);
    rotationSpeed.updateValue(20);
    rotationSpeed.setProps({ minValue: 20, maxValue: 100, minStep: 20 });
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
        await this.enqueueWrite(() => command(value));
        setImmediate(() => {
          if (!this.stopped) {
            this.pushSnapshot(this.snapshot);
          }
        });
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

  private bindAirflowSpeed(characteristicType: CharacteristicType): void {
    this.heaterCoolerService
      .getCharacteristic(characteristicType)
      .onGet(() => this.readCharacteristic('rotationSpeed'))
      .onSet(value => this.scheduleAirflowWrite(value));
  }

  private scheduleAirflowWrite(value: CharacteristicValue): Promise<void> {
    this.requireOnline();
    let speed: PendingAirflowWrite['speed'];
    try {
      speed = airflowSpeed(Number(value));
    } catch {
      return Promise.reject(this.invalidValueError());
    }

    if (this.pendingAirflowWrite !== undefined) {
      if (this.pendingAirflowWrite.timer !== undefined) {
        clearTimeout(this.pendingAirflowWrite.timer);
      }
      this.platform.log.info(
        `EcoFlow diagnostics: coalescing pending HomeKit airflow write to ${speed}%`,
      );
      this.pendingAirflowWrite.speed = speed;
    } else {
      this.platform.log.info(
        `EcoFlow diagnostics: scheduling HomeKit airflow write at ${speed}% `
        + `after ${AIRFLOW_SETTLE_MILLISECONDS}ms settle window`,
      );
      this.pendingAirflowWrite = {
        speed,
        waiters: [],
      };
    }

    const pending = this.pendingAirflowWrite;
    pending.timer = setTimeout(() => {
      this.flushAirflowWrite(pending);
    }, AIRFLOW_SETTLE_MILLISECONDS);

    return new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  private flushAirflowWrite(pending: PendingAirflowWrite): void {
    if (this.pendingAirflowWrite !== pending) {
      return;
    }
    this.pendingAirflowWrite = undefined;

    const alreadyConfirmed = this.snapshot.availability === 'online'
      && this.snapshot.state.airflowSpeed === pending.speed;
    this.platform.log.info(
      alreadyConfirmed
        ? `EcoFlow diagnostics: suppressing HomeKit airflow write because ${pending.speed}% is already confirmed`
        : `EcoFlow diagnostics: dispatching settled HomeKit airflow write at ${pending.speed}%`,
    );
    const execution = alreadyConfirmed
      ? Promise.resolve()
      : this.enqueueWrite(() => ({ type: 'airflowSpeed', speed: pending.speed }));
    void execution.then(
      () => {
        for (const waiter of pending.waiters) {
          waiter.resolve();
        }
      },
      error => {
        for (const waiter of pending.waiters) {
          waiter.reject(error);
        }
      },
    );
  }

  private readCharacteristic(key: HomeKitClimateKey): CharacteristicValue {
    this.requireOnline();
    const value = this.mapSnapshot(this.snapshot)[key];
    if (value === undefined) {
      throw this.communicationError();
    }
    return value;
  }

  private enqueueWrite(command: () => Wave3Command): Promise<void> {
    const execution = this.writeTail.then(async () => {
      this.requireOnline();
      let requestedCommand: Wave3Command;
      try {
        requestedCommand = command();
      } catch (error) {
        if (error instanceof CommandNotAllowedInCurrentStateError) {
          throw this.currentStateError();
        }
        throw this.invalidValueError();
      }
      const result = await this.controller.execute(requestedCommand);
      if (result.status === 'failed') {
        throw this.commandError(result);
      }
    });
    this.writeTail = execution.catch(() => undefined);
    return execution;
  }

  private pushSnapshot(snapshot: Wave3ControllerSnapshot): void {
    if (snapshot.availability !== 'online') {
      const error = this.communicationError();
      for (const characteristicType of this.climateCharacteristics()) {
        this.heaterCoolerService.updateCharacteristic(characteristicType, error);
      }
      return;
    }

    const values = this.mapSnapshot(snapshot);
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

  private mapSnapshot(snapshot: Wave3ControllerSnapshot): HomeKitClimateValues {
    const values = mapSnapshotToHomeKit(
      snapshot,
      this.platform.Characteristic,
      this.lastTargetState,
    );
    if (values.targetState !== undefined
      && (snapshot.state.mode === 'auto'
        || snapshot.state.mode === 'cool'
        || snapshot.state.mode === 'heat')) {
      this.lastTargetState = values.targetState;
      if (this.accessory.context.lastTargetMode !== snapshot.state.mode) {
        this.accessory.context.lastTargetMode = snapshot.state.mode;
        this.platform.api.updatePlatformAccessories([this.accessory]);
      }
    }
    return values;
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

  private currentStateError(): Error {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
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
  lastTargetState?: number,
): HomeKitClimateValues {
  const state = snapshot.state;
  const active = state.powered === undefined
    ? undefined
    : state.powered
      ? characteristic.Active.ACTIVE
      : characteristic.Active.INACTIVE;
  const targetState = targetHomeKitState(
    state,
    characteristic.TargetHeaterCoolerState,
    lastTargetState,
  );
  return {
    active,
    currentState: currentHomeKitState(state, characteristic.CurrentHeaterCoolerState),
    targetState,
    currentTemperature: state.ambientTemperatureCelsius,
    coolingThreshold: state.mode === 'auto'
      ? state.targetTemperatureUpperCelsius
      : state.mode === 'cool'
        ? state.targetTemperatureCelsius
        : undefined,
    heatingThreshold: state.mode === 'auto'
      ? state.targetTemperatureLowerCelsius
      : state.mode === 'heat'
        ? state.targetTemperatureCelsius
        : undefined,
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
  return values.IDLE;
}

function targetHomeKitState(
  state: Readonly<Wave3State>,
  values: EcoFlowWave3Platform['Characteristic']['TargetHeaterCoolerState'],
  lastTargetState?: number,
): number | undefined {
  switch (state.mode) {
  case 'cool':
    return values.COOL;
  case 'heat':
    return values.HEAT;
  case 'auto':
    return values.AUTO;
  case 'off':
    return state.powered === false ? lastTargetState : undefined;
  case 'dry':
  case 'fan':
    return undefined;
  case undefined:
    return state.powered === false ? lastTargetState : undefined;
  }
}

function targetStateForMode(
  mode: Wave3AccessoryContext['lastTargetMode'],
  values: EcoFlowWave3Platform['Characteristic']['TargetHeaterCoolerState'],
): number | undefined {
  if (mode === 'auto') {
    return values.AUTO;
  }
  if (mode === 'cool') {
    return values.COOL;
  }
  if (mode === 'heat') {
    return values.HEAT;
  }
  return undefined;
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
  if ((kind === 'cooling' && state.mode === 'cool')
    || (kind === 'heating' && state.mode === 'heat')) {
    return { type: 'targetTemperature', celsius };
  }
  if (state.mode !== 'auto') {
    throw new CommandNotAllowedInCurrentStateError();
  }
  const other = kind === 'cooling'
    ? state.targetTemperatureLowerCelsius
    : state.targetTemperatureUpperCelsius;
  if (other === undefined) {
    throw new CommandNotAllowedInCurrentStateError();
  }
  const lowerCelsius = kind === 'heating' ? celsius : other;
  const upperCelsius = kind === 'cooling' ? celsius : other;
  if (lowerCelsius > upperCelsius) {
    throw new RangeError('automatic temperature range is invalid');
  }
  return { type: 'automaticTemperatureRange', lowerCelsius, upperCelsius };
}

function validateTemperature(celsius: number): void {
  if (!Number.isFinite(celsius)
    || celsius < 16
    || celsius > 30
    || Math.abs(celsius * 10 - Math.round(celsius * 10)) > 0.0001) {
    throw new RangeError('temperature must use 0.1 degree steps from 16 through 30 Celsius');
  }
}

function airflowSpeed(value: number): 20 | 40 | 60 | 80 | 100 {
  if (!isAirflowSpeed(value)) {
    throw new RangeError('airflow speed must be one of the five supported steps');
  }
  return value;
}

function isAirflowSpeed(value: number | undefined): value is 20 | 40 | 60 | 80 | 100 {
  return value === 20
    || value === 40
    || value === 60
    || value === 80
    || value === 100;
}

class CommandNotAllowedInCurrentStateError extends Error {}
