import {
  devices,
  MatterStatus,
  type MatterAccessory,
  type MatterAPI,
} from 'homebridge';

import type { CurrentTemperatureSource, Wave3DeviceConfig } from './ecoflow/config.js';
import type { Wave3AccessoryController } from './platformAccessory.js';
import type { Wave3MatterAccessoryContext } from './platform.js';
import type {
  Wave3AirflowSpeed,
  Wave3Command,
  Wave3CommandFailure,
  Wave3ControllerSnapshot,
  Wave3Mode,
} from './wave3/domain.js';

const DEFAULT_TEMPERATURE_CENTIDEGREES = 2_000;

export const MATTER_SYSTEM_MODE = {
  auto: 0x01,
  cool: 0x03,
  heat: 0x04,
  fan: 0x07,
  dry: 0x08,
  sleep: 0x09,
} as const;

const MATTER_FAN_MODE = {
  off: 0x00,
  low: 0x01,
  medium: 0x02,
  high: 0x03,
} as const;

const desiredMatterState = new Map<string, unknown>();
const matterControls = new Map<string, Wave3MatterControl>();
const Wave3OnOffBase = devices.RoomAirConditionerRequirements.OnOffServer;
const Wave3ThermostatBase = devices.RoomAirConditionerRequirements.ThermostatServer.with(
  'Heating',
  'Cooling',
  'AutoMode',
);
const Wave3NoTemperatureThermostatBase = devices.RoomAirConditionerRequirements.ThermostatServer.with(
  'Heating',
  'Cooling',
  'AutoMode',
  'LocalTemperatureNotExposed',
);
const MultiSpeedFanControlServer = devices.RoomAirConditionerRequirements.FanControlServer.with(
  'MultiSpeed',
);

class Wave3OnOffServer extends Wave3OnOffBase {
  override async on(): Promise<void> {
    await requireMatterControl(this.endpoint.id).setPower(true, async () => {
      await super.on();
    });
  }

  override async off(): Promise<void> {
    await requireMatterControl(this.endpoint.id).setPower(false, async () => {
      await super.off();
    });
  }

  override async toggle(): Promise<void> {
    await requireMatterControl(this.endpoint.id).setPower(
      !this.state.onOff,
      async () => {
        await super.toggle();
      },
    );
  }
}

class Wave3FanControlServer extends MultiSpeedFanControlServer {
  override initialize(): void {
    super.initialize();
    this.reactTo(this.events.fanMode$Changing, this.validateFanMode);
    this.reactTo(this.events.percentSetting$Changing, this.validatePercentSetting);
    this.reactTo(this.events.speedSetting$Changing, this.validateSpeedSetting);
  }

  private validateFanMode(value: number): void {
    if (!requireDesiredValueOrControl(
      this.endpoint.id,
      'fanControl',
      'fanMode',
      value,
      control => control.setFanMode(value),
    )) {
      return;
    }
    const percent = percentForFanMode(value);
    if (percent !== undefined) {
      this.setRelatedSettings({
        percentSetting: percent,
        speedSetting: speedIndexForPercent(percent),
      });
    }
  }

  private validatePercentSetting(value: number | null, oldValue: number | null): void {
    if (value === null) {
      this.state.percentSetting = oldValue;
      return;
    }
    if (!requireDesiredValueOrControl(
      this.endpoint.id,
      'fanControl',
      'percentSetting',
      value,
      control => control.setFanPercent(value),
    )) {
      return;
    }
    if (value > 0) {
      this.setRelatedSettings({
        fanMode: fanModeForPercent(value),
        speedSetting: speedIndexForPercent(value),
      });
    }
  }

  private validateSpeedSetting(value: number | null, oldValue: number | null): void {
    if (value === null) {
      this.state.speedSetting = oldValue;
      return;
    }
    if (!requireDesiredValueOrControl(
      this.endpoint.id,
      'fanControl',
      'speedSetting',
      value,
      control => control.setFanSpeed(value),
    )) {
      return;
    }
    if (value > 0) {
      const percent = value * 20;
      this.setRelatedSettings({
        fanMode: fanModeForPercent(percent),
        percentSetting: percent,
      });
    }
  }

  private setRelatedSettings(attributes: {
    fanMode?: number;
    percentSetting?: number;
    speedSetting?: number;
  }): void {
    rememberDesiredCluster(this.endpoint.id, 'fanControl', attributes);
    if (attributes.fanMode !== undefined) {
      this.state.fanMode = attributes.fanMode;
    }
    if (attributes.percentSetting !== undefined) {
      this.state.percentSetting = attributes.percentSetting;
    }
    if (attributes.speedSetting !== undefined) {
      this.state.speedSetting = attributes.speedSetting;
    }
    // Matter.js delivers sibling attribute reactions after this validation
    // callback returns, so retain the internal-write markers through that turn.
    setImmediate(() => {
      forgetDesiredCluster(this.endpoint.id, 'fanControl', attributes);
    });
  }
}

class Wave3ThermostatServer extends Wave3ThermostatBase {
  override initialize(): void {
    super.initialize();
    this.reactTo(
      this.events.systemMode$Changing,
      value => {
        requireDesiredValueOrControl(
          this.endpoint.id,
          'thermostat',
          'systemMode',
          value,
          control => control.setSystemMode(value),
        );
      },
    );
    this.reactTo(
      this.events.occupiedHeatingSetpoint$Changing,
      value => {
        requireDesiredValueOrControl(
          this.endpoint.id,
          'thermostat',
          'occupiedHeatingSetpoint',
          value,
          control => control.setHeatingSetpoint(value),
        );
      },
    );
    this.reactTo(
      this.events.occupiedCoolingSetpoint$Changing,
      value => {
        requireDesiredValueOrControl(
          this.endpoint.id,
          'thermostat',
          'occupiedCoolingSetpoint',
          value,
          control => control.setCoolingSetpoint(value),
        );
      },
    );
  }

  override async setpointRaiseLower(request: { mode: number; amount: number }): Promise<void> {
    await requireMatterControl(this.endpoint.id).raiseLowerSetpoint(
      request.mode,
      request.amount,
      async () => {
        await super.setpointRaiseLower(request);
      },
    );
  }
}

class Wave3NoTemperatureThermostatServer extends Wave3NoTemperatureThermostatBase {
  override initialize(): void {
    super.initialize();
    this.reactTo(
      this.events.systemMode$Changing,
      value => {
        requireDesiredValueOrControl(
          this.endpoint.id,
          'thermostat',
          'systemMode',
          value,
          control => control.setSystemMode(value),
        );
      },
    );
    this.reactTo(
      this.events.occupiedHeatingSetpoint$Changing,
      value => {
        requireDesiredValueOrControl(
          this.endpoint.id,
          'thermostat',
          'occupiedHeatingSetpoint',
          value,
          control => control.setHeatingSetpoint(value),
        );
      },
    );
    this.reactTo(
      this.events.occupiedCoolingSetpoint$Changing,
      value => {
        requireDesiredValueOrControl(
          this.endpoint.id,
          'thermostat',
          'occupiedCoolingSetpoint',
          value,
          control => control.setCoolingSetpoint(value),
        );
      },
    );
  }

  override async setpointRaiseLower(request: { mode: number; amount: number }): Promise<void> {
    await requireMatterControl(this.endpoint.id).raiseLowerSetpoint(
      request.mode,
      request.amount,
      async () => {
        await super.setpointRaiseLower(request);
      },
    );
  }
}

export interface MatterAccessoryBinding {
  stop(): void | Promise<void>;
}

export interface MatterAccessoryLogger {
  error(message: string): void;
}

interface Wave3MatterControl {
  setPower(on: boolean, applyMatter: () => Promise<void>): Promise<void>;
  setSystemMode(systemMode: number): void;
  setHeatingSetpoint(centidegrees: number): void;
  setCoolingSetpoint(centidegrees: number): void;
  raiseLowerSetpoint(
    mode: number,
    amount: number,
    applyMatter: () => Promise<void>,
  ): Promise<void>;
  setFanMode(fanMode: number): void;
  setFanPercent(percent: number | null): void;
  setFanSpeed(speed: number | null): void;
}

interface PendingFanWrite {
  generation: number;
  speed: Wave3AirflowSpeed;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

interface PendingTemperatureWrite {
  coolingCelsius?: number;
  heatingCelsius?: number;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

export function wave3RoomAirConditionerDeviceType(
  currentTemperatureSource: CurrentTemperatureSource,
) {
  const requirements = devices.RoomAirConditionerRequirements;
  const thermostat = currentTemperatureSource === 'none'
    ? Wave3NoTemperatureThermostatServer
    : Wave3ThermostatServer;

  return currentTemperatureSource === 'ambient'
    ? devices.RoomAirConditionerDevice.with(
      Wave3OnOffServer,
      thermostat,
      Wave3FanControlServer,
      requirements.RelativeHumidityMeasurementServer,
    )
    : devices.RoomAirConditionerDevice.with(
      Wave3OnOffServer,
      thermostat,
      Wave3FanControlServer,
    );
}

export function createWave3MatterAccessory(
  matter: MatterAPI,
  uuid: string,
  device: Wave3DeviceConfig,
  snapshot: Wave3ControllerSnapshot,
  cached?: MatterAccessory<Wave3MatterAccessoryContext>,
): MatterAccessory<Wave3MatterAccessoryContext> {
  const cachedContext = cached?.context;
  const firmwareRevision = snapshot.firmwareVersions?.pd
    ?? snapshot.firmwareVersions?.iot
    ?? cachedContext?.firmwareRevision
    ?? cached?.firmwareRevision;
  const context: Wave3MatterAccessoryContext = {
    schemaVersion: 1,
    serialNumber: device.serialNumber,
    currentTemperatureSource: device.currentTemperatureSource,
    lastSystemMode: validSystemMode(cachedContext?.lastSystemMode)
      ?? MATTER_SYSTEM_MODE.cool,
    ...(firmwareRevision === undefined ? {} : { firmwareRevision }),
  };
  const clusters = clustersForSnapshot(
    snapshot,
    device.currentTemperatureSource,
    context,
    cached?.clusters,
  );
  rememberDesiredState(uuid, clusters);
  return {
    UUID: uuid,
    displayName: device.name,
    deviceType: wave3RoomAirConditionerDeviceType(device.currentTemperatureSource),
    manufacturer: 'EcoFlow',
    model: 'WAVE 3',
    serialNumber: device.serialNumber,
    ...(firmwareRevision === undefined ? {} : { firmwareRevision }),
    context,
    clusters,
  };
}

export function releaseWave3MatterAccessoryState(uuid: string): void {
  matterControls.delete(uuid);
  forgetDesiredState(uuid);
}

export class Wave3MatterAccessory implements MatterAccessoryBinding {
  private readonly activeCommands = new Set<Promise<void>>();
  private commandTail: Promise<void> = Promise.resolve();
  private readonly detachSnapshot: () => void;
  private deferredSnapshot?: Wave3ControllerSnapshot;
  private interactiveCommandDepth = 0;
  private fanWriteGeneration = 0;
  private updateTail: Promise<void> = Promise.resolve();
  private lastConfirmedSnapshot?: Wave3ControllerSnapshot;
  private presentedFirmwareRevision?: string;
  private snapshot: Wave3ControllerSnapshot;
  private pendingFanWrite?: PendingFanWrite;
  private pendingTemperatureWrite?: PendingTemperatureWrite;
  private stopped = false;

  constructor(
    private readonly matter: MatterAPI,
    private readonly accessory: MatterAccessory<Wave3MatterAccessoryContext>,
    private readonly controller: Wave3AccessoryController,
    private readonly currentTemperatureSource: CurrentTemperatureSource,
    private readonly logger: MatterAccessoryLogger = { error: () => undefined },
  ) {
    this.snapshot = controller.snapshot;
    if (controller.snapshot.availability === 'online') {
      this.lastConfirmedSnapshot = controller.snapshot;
    }
    // Registration has completed before the binding is created. The desired
    // values used to admit asynchronous endpoint construction must not remain
    // as permanent exemptions for later controller writes.
    forgetDesiredState(accessory.UUID);
    matterControls.set(accessory.UUID, this.createMatterControl());
    this.updateTail = this.pushFirmware(
      controller.snapshot.firmwareVersions?.pd
      ?? controller.snapshot.firmwareVersions?.iot
      ?? accessory.context.firmwareRevision
      ?? accessory.firmwareRevision,
    ).catch(error => {
      this.logger.error(`EcoFlow WAVE 3 Matter firmware update failed: ${errorMessage(error)}`);
    });
    this.detachSnapshot = controller.onSnapshot(snapshot => {
      this.snapshot = snapshot;
      if (snapshot.availability === 'online') {
        this.lastConfirmedSnapshot = snapshot;
      }
      if (this.interactiveCommandDepth > 0) {
        this.deferredSnapshot = snapshot;
      } else {
        this.enqueueSnapshot(snapshot);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.updateTail;
      return;
    }
    this.stopped = true;
    this.detachSnapshot();
    if (this.pendingFanWrite !== undefined) {
      if (this.pendingFanWrite.timer !== undefined) {
        clearTimeout(this.pendingFanWrite.timer);
      }
      const error = new MatterStatus.InvalidInState('Matter accessory stopped');
      for (const waiter of this.pendingFanWrite.waiters) {
        waiter.reject(error);
      }
      this.pendingFanWrite = undefined;
    }
    if (this.pendingTemperatureWrite !== undefined) {
      const error = new MatterStatus.InvalidInState('Matter accessory stopped');
      for (const waiter of this.pendingTemperatureWrite.waiters) {
        waiter.reject(error);
      }
      this.pendingTemperatureWrite = undefined;
    }
    await Promise.allSettled([...this.activeCommands]);
    matterControls.delete(this.accessory.UUID);
    forgetDesiredState(this.accessory.UUID);
    await this.updateTail;
    forgetDesiredState(this.accessory.UUID);
  }

  private createMatterControl(): Wave3MatterControl {
    return {
      setPower: (on, applyMatter) => {
        if (!on) {
          this.cancelPendingFan();
        }
        return this.runInteractiveCommand(
          'power',
          () => this.setPower(on, applyMatter),
        );
      },
      setSystemMode: systemMode => this.setSystemMode(systemMode),
      setHeatingSetpoint: value => this.setTemperatureSetpoint('heating', value),
      setCoolingSetpoint: value => this.setTemperatureSetpoint('cooling', value),
      raiseLowerSetpoint: (mode, amount, applyMatter) => this.runInteractiveCommand(
        'setpoint adjustment',
        async () => {
          await this.raiseLowerSetpoint(mode, amount);
          await this.applyConfirmedThermostatMutation(applyMatter);
        },
      ),
      setFanMode: fanMode => this.setFanMode(fanMode),
      setFanPercent: percent => this.setFanPercent(percent),
      setFanSpeed: speed => this.setFanSpeed(speed),
    };
  }

  private restoreConfirmedState(): void {
    if (this.stopped) {
      return;
    }
    const snapshot = this.lastConfirmedSnapshot;
    if (snapshot === undefined) {
      return;
    }
    setImmediate(() => {
      if (this.stopped) {
        return;
      }
      this.updateTail = this.updateTail
        .then(() => this.pushSnapshot(snapshot))
        .catch(error => {
          this.logger.error(`EcoFlow WAVE 3 Matter state restoration failed: ${errorMessage(error)}`);
        });
    });
  }

  private async setPower(on: boolean, applyMatter: () => Promise<void>): Promise<void> {
    this.requireControllable();
    if (this.snapshot.state.powered !== on) {
      await this.execute({ type: 'power', on });
    }
    await applyMatter();
  }

  private async applyConfirmedThermostatMutation(
    applyMatter: () => Promise<void>,
  ): Promise<void> {
    const thermostat = clustersForSnapshot(
      this.snapshot,
      this.currentTemperatureSource,
      this.accessory.context,
      this.accessory.clusters,
    ).thermostat ?? {};
    const desired = {
      occupiedHeatingSetpoint: thermostat.occupiedHeatingSetpoint,
      occupiedCoolingSetpoint: thermostat.occupiedCoolingSetpoint,
    };
    rememberDesiredCluster(this.accessory.UUID, 'thermostat', desired);
    try {
      await applyMatter();
    } finally {
      setImmediate(() => {
        forgetDesiredCluster(this.accessory.UUID, 'thermostat', desired);
      });
    }
  }

  private setSystemMode(systemMode: number): void {
    this.requireControllable();
    if (systemMode === MATTER_SYSTEM_MODE.sleep) {
      this.trackAttributeCommand(
        this.enqueueControllerOperation(async () => {
          this.requireControllable();
          const state = this.snapshot.state;
          if (!state.powered || state.mode === 'off') {
            throw new MatterStatus.InvalidInState('Sleep mode requires the WAVE 3 to be on');
          }
          if (state.submode !== 3) {
            await this.execute({ type: 'submode', submode: 3 });
          }
        }),
        'system mode',
      );
      return;
    }

    const mode = waveModeForSystemMode(systemMode);
    if (mode === undefined) {
      throw new MatterStatus.ConstraintError(`Unsupported Matter system mode ${systemMode}`);
    }
    this.trackAttributeCommand(
      this.enqueueControllerOperation(() => this.applySystemMode(mode)),
      'system mode',
    );
  }

  private async applySystemMode(mode: Exclude<Wave3Mode, 'off'>): Promise<void> {
    const state = this.snapshot.state;
    if (!state.powered || state.mode === 'off') {
      throw new MatterStatus.InvalidInState(
        'Use the Room Air Conditioner power control before selecting a system mode',
      );
    }
    if (state.submode === 3 || state.submode === 2 || state.submode === 4) {
      await this.execute({ type: 'submode', submode: 0 });
    }
    if (this.snapshot.state.mode !== mode || !this.snapshot.state.powered) {
      await this.execute({ type: 'mode', mode });
    }
  }

  private setTemperatureSetpoint(
    kind: 'heating' | 'cooling',
    value: number,
  ): void {
    this.requireControllable();
    const celsius = matterTemperature(value);
    this.trackAttributeCommand(
      this.scheduleTemperatureSetpoint(kind, celsius),
      `${kind} setpoint`,
    );
  }

  private async applyTemperatureSetpoints(
    heatingCelsius?: number,
    coolingCelsius?: number,
  ): Promise<void> {
    this.requireControllable();
    const state = this.snapshot.state;
    if (state.mode === 'auto') {
      let lowerCelsius = heatingCelsius ?? state.targetTemperatureLowerCelsius;
      let upperCelsius = coolingCelsius ?? state.targetTemperatureUpperCelsius;
      if (lowerCelsius === undefined || upperCelsius === undefined) {
        throw new MatterStatus.InvalidInState('Automatic temperature range is not yet known');
      }
      if (lowerCelsius > upperCelsius) {
        if (heatingCelsius !== undefined && coolingCelsius === undefined) {
          upperCelsius = lowerCelsius;
        } else {
          lowerCelsius = upperCelsius;
        }
      }
      if (state.targetTemperatureLowerCelsius !== lowerCelsius
        || state.targetTemperatureUpperCelsius !== upperCelsius) {
        await this.execute({
          type: 'automaticTemperatureRange',
          lowerCelsius,
          upperCelsius,
        });
      }
      return;
    }
    const activeCelsius = state.mode === 'heat'
      ? heatingCelsius
      : state.mode === 'cool'
        ? coolingCelsius
        : undefined;
    if (activeCelsius !== undefined) {
      if (state.targetTemperatureCelsius !== activeCelsius) {
        await this.execute({ type: 'targetTemperature', celsius: activeCelsius });
      }
      return;
    }

    // Matter may move the inactive companion setpoint to preserve its
    // thermostat constraints. That value is not a second WAVE target.
    if ((heatingCelsius !== undefined && state.mode === 'cool')
      || (coolingCelsius !== undefined && state.mode === 'heat')) {
      return;
    }
    throw new MatterStatus.InvalidInState('The requested setpoint is inactive in the current mode');
  }

  private scheduleTemperatureSetpoint(
    kind: 'heating' | 'cooling',
    celsius: number,
  ): Promise<void> {
    if (this.pendingTemperatureWrite === undefined) {
      this.pendingTemperatureWrite = { waiters: [] };
      const pending = this.pendingTemperatureWrite;
      setImmediate(() => {
        void this.flushTemperatureSetpoints(pending);
      });
    }
    const pending = this.pendingTemperatureWrite;
    if (kind === 'heating') {
      pending.heatingCelsius = celsius;
    } else {
      pending.coolingCelsius = celsius;
    }
    return new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  private async flushTemperatureSetpoints(pending: PendingTemperatureWrite): Promise<void> {
    if (this.pendingTemperatureWrite !== pending) {
      return;
    }
    this.pendingTemperatureWrite = undefined;
    try {
      await this.enqueueControllerOperation(() => this.applyTemperatureSetpoints(
        pending.heatingCelsius,
        pending.coolingCelsius,
      ));
      for (const waiter of pending.waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
    }
  }

  private async raiseLowerSetpoint(mode: number, amount: number): Promise<void> {
    this.requireControllable();
    if (!Number.isInteger(amount)) {
      throw new MatterStatus.ConstraintError('Setpoint adjustment must use 0.1 degree steps');
    }
    const delta = amount / 10;
    const state = this.snapshot.state;
    if (mode === 0) {
      const current = state.mode === 'auto'
        ? state.targetTemperatureLowerCelsius
        : state.mode === 'heat'
          ? state.targetTemperatureCelsius
          : undefined;
      if (current === undefined) {
        throw new MatterStatus.InvalidInState('Heating setpoint is not active');
      }
      if (state.mode === 'auto') {
        const lowerCelsius = clampTemperature(current + delta);
        await this.execute({
          type: 'automaticTemperatureRange',
          lowerCelsius,
          upperCelsius: Math.max(state.targetTemperatureUpperCelsius!, lowerCelsius),
        });
      } else {
        await this.execute({
          type: 'targetTemperature',
          celsius: clampTemperature(current + delta),
        });
      }
      return;
    }
    if (mode === 1) {
      const current = state.mode === 'auto'
        ? state.targetTemperatureUpperCelsius
        : state.mode === 'cool'
          ? state.targetTemperatureCelsius
          : undefined;
      if (current === undefined) {
        throw new MatterStatus.InvalidInState('Cooling setpoint is not active');
      }
      if (state.mode === 'auto') {
        const upperCelsius = clampTemperature(current + delta);
        await this.execute({
          type: 'automaticTemperatureRange',
          lowerCelsius: Math.min(state.targetTemperatureLowerCelsius!, upperCelsius),
          upperCelsius,
        });
      } else {
        await this.execute({
          type: 'targetTemperature',
          celsius: clampTemperature(current + delta),
        });
      }
      return;
    }
    if (mode === 2 && state.mode === 'auto') {
      const lower = state.targetTemperatureLowerCelsius;
      const upper = state.targetTemperatureUpperCelsius;
      if (lower === undefined || upper === undefined) {
        throw new MatterStatus.InvalidInState('Automatic temperature range is not yet known');
      }
      const appliedDelta = Math.max(16 - lower, Math.min(delta, 30 - upper));
      await this.execute({
        type: 'automaticTemperatureRange',
        lowerCelsius: roundedTenth(lower + appliedDelta),
        upperCelsius: roundedTenth(upper + appliedDelta),
      });
      return;
    }
    throw new MatterStatus.InvalidInState('Requested setpoint adjustment is not active');
  }

  private setFanMode(fanMode: number): void {
    if (fanMode === MATTER_FAN_MODE.off) {
      throw new MatterStatus.InvalidInState(
        'Use the Room Air Conditioner power control to turn off',
      );
    }
    const speed = fanMode === MATTER_FAN_MODE.low
      ? 20
      : fanMode === MATTER_FAN_MODE.medium
        ? 60
        : fanMode === MATTER_FAN_MODE.high
          ? 100
          : undefined;
    if (speed === undefined) {
      throw new MatterStatus.ConstraintError(`Unsupported Matter fan mode ${fanMode}`);
    }
    this.trackAttributeCommand(this.scheduleFan(speed), 'fan mode');
  }

  private setFanPercent(percent: number | null): void {
    if (percent === 0) {
      throw new MatterStatus.InvalidInState(
        'Use the Room Air Conditioner power control to turn off',
      );
    }
    if (percent === null || percent < 0 || percent > 100) {
      throw new MatterStatus.ConstraintError('Fan percentage must be between 1 and 100');
    }
    this.trackAttributeCommand(
      this.scheduleFan(normalizedAirflow(percent) as Wave3AirflowSpeed),
      'fan percentage',
    );
  }

  private setFanSpeed(speed: number | null): void {
    if (speed === 0) {
      throw new MatterStatus.InvalidInState(
        'Use the Room Air Conditioner power control to turn off',
      );
    }
    if (speed === null || !Number.isInteger(speed) || speed < 0 || speed > 5) {
      throw new MatterStatus.ConstraintError('Fan speed must be between 1 and 5');
    }
    this.trackAttributeCommand(
      this.scheduleFan((speed * 20) as Wave3AirflowSpeed),
      'fan speed',
    );
  }

  private trackAttributeCommand(command: Promise<void>, description: string): void {
    const tracked = command
      .catch(error => {
        if (!this.stopped) {
          this.logger.error(
            `EcoFlow WAVE 3 Matter ${description} command failed: ${errorMessage(error)}`,
          );
          this.restoreConfirmedState();
        }
      })
      .finally(() => {
        this.activeCommands.delete(tracked);
      });
    this.activeCommands.add(tracked);
  }

  private runInteractiveCommand(
    description: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.interactiveCommandDepth += 1;
    const reported = this.enqueueControllerOperation(async () => {
      // Homebridge 2.2 dispatches snapshot writes asynchronously. Let an
      // already-dispatched projection release its cluster lock before this
      // command asks Matter.js to mutate the same state transactionally.
      await this.updateTail;
      await operation();
    })
      .catch(error => {
        this.logger.error(
          `EcoFlow WAVE 3 Matter ${description} command failed: ${errorMessage(error)}`,
        );
        throw error;
      })
      .finally(() => {
        // The command handler returns before Matter.js commits and releases its
        // cluster transaction. Reconcile cloud state on the next event-loop turn,
        // and keep it deferred if another interactive command has already begun.
        setImmediate(() => {
          this.interactiveCommandDepth -= 1;
          if (this.stopped) {
            this.deferredSnapshot = undefined;
            return;
          }
          if (this.interactiveCommandDepth === 0 && this.deferredSnapshot !== undefined) {
            const snapshot = this.deferredSnapshot;
            this.deferredSnapshot = undefined;
            this.enqueueSnapshot(snapshot);
          }
        });
      });
    const tracked = reported.finally(() => {
      this.activeCommands.delete(tracked);
    });
    this.activeCommands.add(tracked);
    return tracked;
  }

  private enqueueControllerOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.commandTail.then(async () => {
      if (this.stopped) {
        throw new MatterStatus.InvalidInState('Matter accessory stopped');
      }
      await operation();
    });
    this.commandTail = queued.catch(() => undefined);
    return queued;
  }

  private enqueueSnapshot(snapshot: Wave3ControllerSnapshot): void {
    this.updateTail = this.updateTail
      .then(() => this.pushSnapshot(snapshot))
      .catch(error => {
        if (!this.stopped && this.snapshot === snapshot) {
          this.logger.error(`EcoFlow WAVE 3 Matter state update failed: ${errorMessage(error)}`);
        }
      });
  }

  private scheduleFan(speed: Wave3AirflowSpeed): Promise<void> {
    this.requireControllable();
    if (!this.snapshot.state.powered) {
      throw new MatterStatus.InvalidInState('Use the Room Air Conditioner power control to turn on');
    }
    if (this.snapshot.state.airflowSpeed === speed && this.pendingFanWrite === undefined) {
      return Promise.resolve();
    }
    if (this.pendingFanWrite === undefined) {
      this.pendingFanWrite = {
        generation: this.fanWriteGeneration,
        speed,
        waiters: [],
      };
    } else {
      this.pendingFanWrite.speed = speed;
      if (this.pendingFanWrite.timer !== undefined) {
        clearTimeout(this.pendingFanWrite.timer);
      }
    }
    const pending = this.pendingFanWrite;
    const result = new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
    pending.timer = setTimeout(() => {
      void this.flushFan(pending);
    }, 750);
    return result;
  }

  private async flushFan(pending: PendingFanWrite): Promise<void> {
    if (this.pendingFanWrite !== pending) {
      return;
    }
    this.pendingFanWrite = undefined;
    try {
      await this.enqueueControllerOperation(async () => {
        if (pending.generation !== this.fanWriteGeneration) {
          return;
        }
        this.requireControllable();
        if (!this.snapshot.state.powered) {
          throw new MatterStatus.InvalidInState(
            'Use the Room Air Conditioner power control to turn on',
          );
        }
        if (normalizedAirflow(this.snapshot.state.airflowSpeed) !== pending.speed) {
          await this.execute({ type: 'airflowSpeed', speed: pending.speed });
        }
      });
      for (const waiter of pending.waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
    }
  }

  private cancelPendingFan(): void {
    this.fanWriteGeneration += 1;
    const pending = this.pendingFanWrite;
    if (pending === undefined) {
      return;
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    this.pendingFanWrite = undefined;
    for (const waiter of pending.waiters) {
      waiter.resolve();
    }
  }

  private requireControllable(): void {
    if (this.stopped) {
      throw new MatterStatus.InvalidInState('Matter accessory stopped');
    }
    if (this.snapshot.availability !== 'online') {
      throw new MatterStatus.InvalidInState('EcoFlow WAVE 3 is not currently controllable');
    }
  }

  private async execute(command: Wave3Command): Promise<void> {
    let result;
    try {
      result = await this.controller.execute(command);
    } catch (error) {
      if (MatterStatus.isMatterProtocolError(error)) {
        throw error;
      }
      throw new MatterStatus.Failure(`EcoFlow WAVE 3 command failed: ${errorMessage(error)}`);
    }
    if (result.status === 'confirmed') {
      return;
    }
    throw matterErrorForFailure(result.reason);
  }

  private async pushSnapshot(snapshot: Wave3ControllerSnapshot): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (snapshot.availability !== 'online') {
      return;
    }

    await this.pushFirmware(snapshot.firmwareVersions?.pd ?? snapshot.firmwareVersions?.iot);

    if (this.stopped) {
      return;
    }

    const clusters = clustersForSnapshot(
      snapshot,
      this.currentTemperatureSource,
      this.accessory.context,
      this.accessory.clusters,
    );
    this.accessory.clusters = clusters;
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.OnOff,
      clusters.onOff ?? {},
    );
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.Thermostat,
      clusters.thermostat ?? {},
    );
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.FanControl,
      clusters.fanControl ?? {},
    );
    if (this.currentTemperatureSource === 'ambient') {
      await this.updateState(
        this.accessory.UUID,
        this.matter.clusterNames.RelativeHumidityMeasurement,
        clusters.relativeHumidityMeasurement ?? {},
      );
    }
  }

  private async updateState(
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>,
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    rememberDesiredCluster(uuid, cluster, attributes);
    try {
      await this.matter.updateAccessoryState(uuid, cluster, attributes);
      if (!await waitForAttributes(this.matter, uuid, cluster, attributes)) {
        throw new Error('Matter state update was not confirmed by Homebridge');
      }
    } finally {
      forgetDesiredCluster(uuid, cluster, attributes);
    }
  }

  private async pushFirmware(firmwareRevision: string | undefined): Promise<void> {
    if (firmwareRevision === undefined || firmwareRevision === this.presentedFirmwareRevision) {
      return;
    }
    const cluster = this.matter.clusterNames.BridgedDeviceBasicInformation;
    const attributes = {
      softwareVersion: packedFirmwareVersion(firmwareRevision),
      softwareVersionString: firmwareRevision,
    };
    const ready = await waitForCluster(this.matter, this.accessory.UUID, cluster);
    if (!ready || this.stopped) {
      return;
    }
    await this.matter.updateAccessoryState(
      this.accessory.UUID,
      cluster,
      attributes,
    );
    if (this.stopped) {
      return;
    }
    if (!await waitForAttributes(this.matter, this.accessory.UUID, cluster, attributes)) {
      return;
    }
    if (this.stopped) {
      return;
    }
    this.accessory.firmwareRevision = firmwareRevision;
    this.accessory.context.firmwareRevision = firmwareRevision;
    this.presentedFirmwareRevision = firmwareRevision;
  }
}

function clustersForSnapshot(
  snapshot: Wave3ControllerSnapshot,
  currentTemperatureSource: CurrentTemperatureSource,
  context: Wave3MatterAccessoryContext,
  previous: MatterAccessory['clusters'] = {},
): NonNullable<MatterAccessory['clusters']> {
  const state = snapshot.state;
  if (snapshot.availability === 'online') {
    const systemMode = systemModeForState(state.mode, state.submode);
    if (systemMode !== undefined) {
      context.lastSystemMode = systemMode;
    }
  }

  const previousThermostat = previous?.thermostat ?? {};
  const previousFan = previous?.fanControl ?? {};
  const temperature = currentTemperatureSource === 'ambient'
    ? state.ambientTemperatureCelsius
    : currentTemperatureSource === 'outlet'
      ? state.outletTemperatureCelsius
      : undefined;
  const coolingSetpoint = state.mode === 'auto'
    ? state.targetTemperatureUpperCelsius
    : state.mode === 'cool'
      ? state.targetTemperatureCelsius
      : undefined;
  const heatingSetpoint = state.mode === 'auto'
    ? state.targetTemperatureLowerCelsius
    : state.mode === 'heat'
      ? state.targetTemperatureCelsius
      : undefined;
  let projectedCoolingSetpoint = coolingSetpoint === undefined
    ? numberOrUndefined(previousThermostat.occupiedCoolingSetpoint)
      ?? DEFAULT_TEMPERATURE_CENTIDEGREES
    : centidegrees(coolingSetpoint);
  let projectedHeatingSetpoint = heatingSetpoint === undefined
    ? numberOrUndefined(previousThermostat.occupiedHeatingSetpoint)
      ?? DEFAULT_TEMPERATURE_CENTIDEGREES
    : centidegrees(heatingSetpoint);
  if (projectedHeatingSetpoint > projectedCoolingSetpoint) {
    if (heatingSetpoint !== undefined && coolingSetpoint === undefined) {
      projectedCoolingSetpoint = projectedHeatingSetpoint;
    } else {
      projectedHeatingSetpoint = projectedCoolingSetpoint;
    }
  }
  const airflow = normalizedAirflow(state.airflowSpeed)
    ?? numberOrUndefined(previousFan.percentSetting)
    ?? 20;
  const powered = state.powered
    ?? booleanOrUndefined(previous?.onOff?.onOff)
    ?? false;

  const clusters: NonNullable<MatterAccessory['clusters']> = {
    ...previous,
    onOff: { onOff: powered },
    thermostat: {
      ...previousThermostat,
      localTemperature: currentTemperatureSource === 'none'
        ? null
        : temperature === undefined
          ? nullableNumber(previousThermostat.localTemperature)
          : centidegrees(temperature),
      occupiedCoolingSetpoint: projectedCoolingSetpoint,
      occupiedHeatingSetpoint: projectedHeatingSetpoint,
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
      systemMode: context.lastSystemMode ?? MATTER_SYSTEM_MODE.cool,
    },
    fanControl: {
      ...previousFan,
      fanMode: powered ? fanModeForAirflow(airflow) : MATTER_FAN_MODE.off,
      fanModeSequence: 0,
      percentSetting: powered ? airflow : 0,
      percentCurrent: powered ? airflow : 0,
      speedMax: 5,
      speedSetting: powered ? speedIndex(airflow) : 0,
      speedCurrent: powered ? speedIndex(airflow) : 0,
    },
  };

  // The display packets identify the selected operating mode, not whether the
  // compressor is currently heating or cooling. ThermostatRunningMode is an
  // optional attribute, so omit it until the protocol supplies direct
  // activity evidence. Also remove it from pre-0.2 cached cluster state.
  delete clusters.thermostat?.thermostatRunningMode;

  if (currentTemperatureSource === 'ambient') {
    clusters.relativeHumidityMeasurement = {
      measuredValue: state.ambientHumidityPercent === undefined
        ? nullableNumber(previous?.relativeHumidityMeasurement?.measuredValue)
        : centipercent(state.ambientHumidityPercent),
      minMeasuredValue: 0,
      maxMeasuredValue: 10_000,
    };
  } else {
    delete clusters.relativeHumidityMeasurement;
  }

  return clusters;
}

function rememberDesiredState(
  uuid: string,
  clusters: NonNullable<MatterAccessory['clusters']>,
): void {
  for (const [cluster, attributes] of Object.entries(clusters)) {
    rememberDesiredCluster(uuid, cluster, attributes);
  }
}

function forgetDesiredState(uuid: string): void {
  const prefix = `${uuid}\u0000`;
  for (const key of desiredMatterState.keys()) {
    if (key.startsWith(prefix)) {
      desiredMatterState.delete(key);
    }
  }
}

function rememberDesiredCluster(
  uuid: string,
  cluster: string,
  attributes: Record<string, unknown>,
): void {
  for (const [attribute, value] of Object.entries(attributes)) {
    desiredMatterState.set(desiredStateKey(uuid, cluster, attribute), value);
  }
}

function forgetDesiredCluster(
  uuid: string,
  cluster: string,
  attributes: Record<string, unknown>,
): void {
  for (const [attribute, value] of Object.entries(attributes)) {
    const key = desiredStateKey(uuid, cluster, attribute);
    if (Object.is(desiredMatterState.get(key), value)) {
      desiredMatterState.delete(key);
    }
  }
}

function requireDesiredValueOrControl(
  uuid: string,
  cluster: string,
  attribute: string,
  value: unknown,
  control: (control: Wave3MatterControl) => void,
): boolean {
  if (Object.is(desiredMatterState.get(desiredStateKey(uuid, cluster, attribute)), value)) {
    return false;
  }
  control(requireMatterControl(uuid));
  return true;
}

function desiredStateKey(uuid: string, cluster: string, attribute: string): string {
  return `${uuid}\u0000${cluster}\u0000${attribute}`;
}

function controlsUnavailable(): Error {
  return new Error('Matter controls are unavailable until command mapping is initialized');
}

function requireMatterControl(uuid: string): Wave3MatterControl {
  const control = matterControls.get(uuid);
  if (control === undefined) {
    throw controlsUnavailable();
  }
  return control;
}

function waveModeForSystemMode(systemMode: number): Exclude<Wave3Mode, 'off'> | undefined {
  switch (systemMode) {
  case MATTER_SYSTEM_MODE.auto:
    return 'auto';
  case MATTER_SYSTEM_MODE.cool:
    return 'cool';
  case MATTER_SYSTEM_MODE.heat:
    return 'heat';
  case MATTER_SYSTEM_MODE.fan:
    return 'fan';
  case MATTER_SYSTEM_MODE.dry:
    return 'dry';
  default:
    return undefined;
  }
}

function matterTemperature(value: number): number {
  if (!Number.isInteger(value)) {
    throw new MatterStatus.ConstraintError('Temperature must be an integer number of centidegrees');
  }
  const celsius = value / 100;
  if (celsius < 16 || celsius > 30 || Math.abs(celsius * 10 - Math.round(celsius * 10)) > 0.0001) {
    throw new MatterStatus.ConstraintError('Temperature must be 16–30°C in 0.1°C steps');
  }
  return roundedTenth(celsius);
}

function roundedTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampTemperature(value: number, minimum = 16, maximum = 30): number {
  return roundedTenth(Math.max(minimum, Math.min(maximum, value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matterErrorForFailure(reason: Wave3CommandFailure): Error {
  switch (reason) {
  case 'timeout':
    return new MatterStatus.Timeout('EcoFlow WAVE 3 did not confirm the command');
  case 'disconnected':
  case 'stopped':
    return new MatterStatus.InvalidInState('EcoFlow WAVE 3 is not currently controllable');
  case 'acknowledgementRejected':
    return new MatterStatus.Failure('EcoFlow WAVE 3 rejected the command');
  case 'publicationFailed':
    return new MatterStatus.Failure('EcoFlow cloud did not accept the command');
  }
}

async function waitForCluster(
  matter: MatterAPI,
  uuid: string,
  cluster: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (await matter.getAccessoryState(uuid, cluster) !== undefined) {
        return true;
      }
    } catch {
      // Homebridge reports a missing endpoint while bridged registration is in flight.
    }
    await delay(25);
  }
  return false;
}

async function waitForAttributes(
  matter: MatterAPI,
  uuid: string,
  cluster: string,
  expected: Record<string, unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const state = await matter.getAccessoryState(uuid, cluster);
      if (state !== undefined && Object.entries(expected).every(
        ([attribute, value]) => Object.is(state[attribute], value),
      )) {
        return true;
      }
    } catch {
      // Retry while Homebridge finishes endpoint registration or a deferred update.
    }
    await delay(25);
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function packedFirmwareVersion(version: string): number {
  const parts = version.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return 1;
  }
  return (
    ((parts[0]! << 24) >>> 0)
    | (parts[1]! << 16)
    | (parts[2]! << 8)
    | parts[3]!
  ) >>> 0;
}

function systemModeForState(mode: Wave3Mode | undefined, submode: number | undefined): number | undefined {
  if (submode === 3 && mode !== 'off') {
    return MATTER_SYSTEM_MODE.sleep;
  }
  if (mode === undefined || mode === 'off') {
    return undefined;
  }
  return MATTER_SYSTEM_MODE[mode];
}

function normalizedAirflow(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(20, Math.min(100, Math.round(value / 20) * 20));
}

function fanModeForAirflow(airflow: number): number {
  if (airflow <= 33) {
    return MATTER_FAN_MODE.low;
  }
  if (airflow <= 66) {
    return MATTER_FAN_MODE.medium;
  }
  return MATTER_FAN_MODE.high;
}

function fanModeForPercent(percent: number): number {
  return fanModeForAirflow(percent);
}

function percentForFanMode(fanMode: number): number | undefined {
  switch (fanMode) {
  case MATTER_FAN_MODE.low:
    return 20;
  case MATTER_FAN_MODE.medium:
    return 60;
  case MATTER_FAN_MODE.high:
    return 100;
  default:
    return undefined;
  }
}

function speedIndexForPercent(percent: number): number {
  return Math.max(1, Math.min(5, Math.ceil(percent / 20)));
}

function speedIndex(percent: number): number {
  return Math.max(1, Math.min(5, Math.round(percent / 20)));
}

function centidegrees(value: number): number {
  return Math.round(value * 100);
}

function centipercent(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value * 100)));
}

function validSystemMode(value: unknown): number | undefined {
  return typeof value === 'number' && Object.values(MATTER_SYSTEM_MODE).includes(
    value as (typeof MATTER_SYSTEM_MODE)[keyof typeof MATTER_SYSTEM_MODE],
  ) ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}
