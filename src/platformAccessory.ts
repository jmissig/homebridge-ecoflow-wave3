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
import type { CurrentTemperatureSource } from './ecoflow/config.js';
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

type TemperatureThresholdKind = 'cooling' | 'heating';

interface PendingTemperatureWrite {
  celsius: number;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

/**
 * HomeKit presentation boundary for one EcoFlow WAVE 3.
 */
export class Wave3PlatformAccessory {
  public readonly heaterCoolerService: Service;
  public readonly humiditySensorService?: Service;
  private readonly informationService: Service;

  private snapshot: Wave3ControllerSnapshot;
  private readonly lastPresentedValues: HomeKitClimateValues = {
    coolingThreshold: 16,
    heatingThreshold: 16,
    rotationSpeed: 20,
  };
  private hasConfirmedPresentation = false;
  private readonly detachSnapshot: () => void;
  private writeTail: Promise<void> = Promise.resolve();
  private pendingAirflowWrite?: PendingAirflowWrite;
  private readonly pendingTemperatureWrites = new Map<
    TemperatureThresholdKind,
    PendingTemperatureWrite
  >();
  private lastTargetState?: number;
  private stopped = false;

  constructor(
    private readonly platform: EcoFlowWave3Platform,
    private readonly accessory: PlatformAccessory<Wave3AccessoryContext>,
    private readonly controller: Wave3AccessoryController,
    private readonly currentTemperatureSource: CurrentTemperatureSource = 'ambient',
  ) {
    this.snapshot = controller.snapshot;
    this.lastTargetState = targetStateForMode(
      accessory.context.lastTargetMode,
      this.platform.Characteristic.TargetHeaterCoolerState,
    );
    this.informationService = this.accessory.getService(
      this.platform.Service.AccessoryInformation,
    )!;
    this.informationService
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

    const existingHumidity = this.accessory.getService(this.platform.Service.HumiditySensor);
    if (this.currentTemperatureSource === 'ambient') {
      const humidityName = `${this.accessory.displayName} Humidity`;
      this.humiditySensorService = existingHumidity ?? this.accessory.addService(
        this.platform.Service.HumiditySensor,
        humidityName,
      );
      this.humiditySensorService.setCharacteristic(
        this.platform.Characteristic.Name,
        humidityName,
      );
    } else if (existingHumidity !== undefined) {
      this.accessory.removeService(existingHumidity);
    }

    if (this.currentTemperatureSource === 'none') {
      this.heaterCoolerService.removeCharacteristic(
        this.heaterCoolerService.getCharacteristic(
          this.platform.Characteristic.CurrentTemperature,
        ),
      );
    }

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
    const error = this.communicationError();
    for (const pending of this.pendingTemperatureWrites.values()) {
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
    }
    this.pendingTemperatureWrites.clear();
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
    this.bindTemperatureThreshold(
      characteristic.CoolingThresholdTemperature,
      'coolingThreshold',
      'cooling',
    );
    this.bindTemperatureThreshold(
      characteristic.HeatingThresholdTemperature,
      'heatingThreshold',
      'heating',
    );
    this.bindAirflowSpeed(characteristic.RotationSpeed);
    this.bindReadOnly(characteristic.CurrentHeaterCoolerState, 'currentState');
    if (this.currentTemperatureSource !== 'none') {
      this.bindReadOnly(characteristic.CurrentTemperature, 'currentTemperature');
    }
    this.humiditySensorService
      ?.getCharacteristic(characteristic.CurrentRelativeHumidity)
      .onGet(() => this.readAmbientHumidity());
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

  private bindTemperatureThreshold(
    characteristicType: CharacteristicType,
    key: 'coolingThreshold' | 'heatingThreshold',
    kind: TemperatureThresholdKind,
  ): void {
    this.heaterCoolerService
      .getCharacteristic(characteristicType)
      .onGet(() => this.readCharacteristic(key))
      .onSet(value => this.scheduleTemperatureWrite(kind, value));
  }

  private scheduleTemperatureWrite(
    kind: TemperatureThresholdKind,
    value: CharacteristicValue,
  ): Promise<void> {
    this.requireOnline();
    const celsius = Number(value);
    try {
      validateTemperature(celsius);
    } catch {
      return Promise.reject(this.invalidValueError());
    }

    let pending = this.pendingTemperatureWrites.get(kind);
    if (pending !== undefined) {
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      this.platform.log.info(
        `EcoFlow diagnostics: coalescing pending HomeKit ${kind} temperature write to ${celsius}°C`,
      );
      pending.celsius = celsius;
    } else {
      this.platform.log.info(
        `EcoFlow diagnostics: scheduling HomeKit ${kind} temperature write at ${celsius}°C `
        + `after ${this.platform.homeKitWriteSettleMilliseconds}ms settle window`,
      );
      pending = { celsius, waiters: [] };
      this.pendingTemperatureWrites.set(kind, pending);
    }

    pending.timer = setTimeout(() => {
      this.flushTemperatureWrite(kind, pending);
    }, this.platform.homeKitWriteSettleMilliseconds);
    return new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  private flushTemperatureWrite(
    kind: TemperatureThresholdKind,
    pending: PendingTemperatureWrite,
  ): void {
    if (this.pendingTemperatureWrites.get(kind) !== pending) {
      return;
    }
    this.pendingTemperatureWrites.delete(kind);

    const mapped = this.mapSnapshot(this.snapshot);
    const confirmed = kind === 'cooling'
      ? mapped.coolingThreshold
      : mapped.heatingThreshold;
    const alreadyConfirmed = this.snapshot.availability === 'online'
      && confirmed === pending.celsius;
    this.platform.log.info(
      alreadyConfirmed
        ? `EcoFlow diagnostics: suppressing HomeKit ${kind} temperature write because ${pending.celsius}°C is already confirmed`
        : `EcoFlow diagnostics: dispatching settled HomeKit ${kind} temperature write at ${pending.celsius}°C`,
    );
    const execution = alreadyConfirmed
      ? Promise.resolve()
      : this.enqueueWrite(() => thresholdCommand(kind, pending.celsius, this.snapshot.state));
    void execution.then(
      () => {
        this.reconcileSnapshotAfterWrite();
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
        + `after ${this.platform.homeKitWriteSettleMilliseconds}ms settle window`,
      );
      this.pendingAirflowWrite = {
        speed,
        waiters: [],
      };
    }

    const pending = this.pendingAirflowWrite;
    pending.timer = setTimeout(() => {
      this.flushAirflowWrite(pending);
    }, this.platform.homeKitWriteSettleMilliseconds);

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
        this.reconcileSnapshotAfterWrite();
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
    if (this.snapshot.availability === 'accountError') {
      throw this.communicationError();
    }
    const liveValue = this.snapshot.availability === 'online'
      ? this.mapSnapshot(this.snapshot)[key]
      : undefined;
    const value = liveValue ?? (this.hasConfirmedPresentation
      ? this.lastPresentedValues[key]
      : undefined) ?? this.cachedCharacteristicValue(key);
    if (value === undefined || value === null || value instanceof Error) {
      return this.defaultCharacteristicValue(key);
    }
    return value;
  }

  private reconcileSnapshotAfterWrite(): void {
    setImmediate(() => {
      if (!this.stopped) {
        this.pushSnapshot(this.snapshot);
      }
    });
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
    const firmwareRevision = snapshot.firmwareVersions?.pd
      ?? snapshot.firmwareVersions?.iot;
    if (firmwareRevision !== undefined) {
      this.informationService.updateCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        firmwareRevision,
      );
    }

    if (snapshot.availability === 'accountError') {
      const error = this.communicationError();
      for (const characteristicType of this.climateCharacteristics()) {
        this.heaterCoolerService.updateCharacteristic(characteristicType, error);
      }
      this.humiditySensorService?.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        error,
      );
      return;
    }

    if (snapshot.availability === 'stopped') {
      return;
    }

    if (snapshot.availability === 'online') {
      const liveValues = this.mapSnapshot(snapshot);
      for (const [key, value] of Object.entries(liveValues) as Array<
        [keyof HomeKitClimateValues, number | undefined]
      >) {
        if (value !== undefined) {
          this.lastPresentedValues[key] = value;
        }
      }
      if (hasUsableHomeKitPresentation(
        snapshot,
        liveValues,
        this.currentTemperatureSource,
      )) {
        this.hasConfirmedPresentation = true;
      }
      if (snapshot.state.ambientHumidityPercent !== undefined) {
        this.humiditySensorService?.updateCharacteristic(
          this.platform.Characteristic.CurrentRelativeHumidity,
          homeKitHumidity(snapshot.state.ambientHumidityPercent),
        );
      }
    } else {
      this.platform.log.info(
        `EcoFlow diagnostics: retaining last confirmed HomeKit values while device availability=${snapshot.availability}`,
      );
    }

    if (!this.hasConfirmedPresentation) {
      this.platform.log.info(
        'EcoFlow diagnostics: leaving cached HomeKit values untouched while awaiting '
        + `the first trustworthy device snapshot (availability=${snapshot.availability})`,
      );
      return;
    }

    const values = this.lastPresentedValues;
    const characteristic = this.platform.Characteristic;
    const mappings = [
      [characteristic.Active, values.active],
      [characteristic.CurrentHeaterCoolerState, values.currentState],
      [characteristic.TargetHeaterCoolerState, values.targetState],
      ...(this.currentTemperatureSource === 'none'
        ? []
        : [[characteristic.CurrentTemperature, values.currentTemperature]] as const),
      [characteristic.CoolingThresholdTemperature, values.coolingThreshold],
      [characteristic.HeatingThresholdTemperature, values.heatingThreshold],
      [characteristic.RotationSpeed, values.rotationSpeed],
    ] as const;
    for (const [characteristicType, value] of mappings) {
      if (value !== undefined) {
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
      ...(this.currentTemperatureSource === 'none'
        ? []
        : [characteristic.CurrentTemperature]),
      characteristic.CoolingThresholdTemperature,
      characteristic.HeatingThresholdTemperature,
      characteristic.RotationSpeed,
    ];
  }

  private cachedCharacteristicValue(key: HomeKitClimateKey): CharacteristicValue | null {
    return this.heaterCoolerService
      .getCharacteristic(this.characteristicTypeForKey(key))
      .value;
  }

  private readAmbientHumidity(): CharacteristicValue {
    if (this.snapshot.availability === 'accountError') {
      throw this.communicationError();
    }
    const liveHumidity = this.snapshot.availability === 'online'
      ? this.snapshot.state.ambientHumidityPercent
      : undefined;
    if (liveHumidity !== undefined) {
      return homeKitHumidity(liveHumidity);
    }
    const cached = this.humiditySensorService!
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .value;
    return typeof cached === 'number' ? cached : 0;
  }

  private characteristicTypeForKey(key: HomeKitClimateKey): CharacteristicType {
    const characteristic = this.platform.Characteristic;
    switch (key) {
    case 'active':
      return characteristic.Active;
    case 'currentState':
      return characteristic.CurrentHeaterCoolerState;
    case 'targetState':
      return characteristic.TargetHeaterCoolerState;
    case 'currentTemperature':
      return characteristic.CurrentTemperature;
    case 'coolingThreshold':
      return characteristic.CoolingThresholdTemperature;
    case 'heatingThreshold':
      return characteristic.HeatingThresholdTemperature;
    case 'rotationSpeed':
      return characteristic.RotationSpeed;
    }
  }

  private defaultCharacteristicValue(key: HomeKitClimateKey): number {
    const characteristic = this.platform.Characteristic;
    switch (key) {
    case 'active':
      return characteristic.Active.INACTIVE;
    case 'currentState':
      return characteristic.CurrentHeaterCoolerState.INACTIVE;
    case 'targetState':
      return this.lastTargetState
        ?? characteristic.TargetHeaterCoolerState.COOL;
    case 'currentTemperature':
      return 20;
    case 'coolingThreshold':
    case 'heatingThreshold':
      return 16;
    case 'rotationSpeed':
      return 20;
    }
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
      this.currentTemperatureSource,
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

function homeKitHumidity(percent: number): number {
  return Math.round(Math.min(100, Math.max(0, percent)));
}

export function mapSnapshotToHomeKit(
  snapshot: Wave3ControllerSnapshot,
  characteristic: EcoFlowWave3Platform['Characteristic'],
  lastTargetState?: number,
  currentTemperatureSource: CurrentTemperatureSource = 'ambient',
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
    currentTemperature: currentTemperatureSource === 'ambient'
      ? state.ambientTemperatureCelsius
      : currentTemperatureSource === 'outlet'
        ? state.outletTemperatureCelsius
        : undefined,
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

function hasUsableHomeKitPresentation(
  snapshot: Wave3ControllerSnapshot,
  values: HomeKitClimateValues,
  currentTemperatureSource: CurrentTemperatureSource = 'ambient',
): boolean {
  if (values.active === undefined
    || values.currentState === undefined
    || (currentTemperatureSource !== 'none'
      && values.currentTemperature === undefined)) {
    return false;
  }
  if (snapshot.state.powered === false) {
    return true;
  }
  if (values.targetState === undefined) {
    return false;
  }
  if (snapshot.state.mode === 'cool') {
    return values.coolingThreshold !== undefined;
  }
  if (snapshot.state.mode === 'heat') {
    return values.heatingThreshold !== undefined;
  }
  if (snapshot.state.mode === 'auto') {
    return values.coolingThreshold !== undefined
      && values.heatingThreshold !== undefined;
  }
  return false;
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
