import { isDeepStrictEqual } from 'node:util';

import {
  MatterStatus,
  type MatterAccessory,
  type MatterAPI,
} from 'homebridge';

import type { Wave3DeviceConfig } from './ecoflow/config.js';
import {
  CACHED_STATE_MAX_AGE_MILLISECONDS,
  isRecentCachedState,
} from './matter/cachePolicy.js';
import {
  MATTER_FAN_MODE,
  MATTER_SYSTEM_MODE,
  MATTER_TEMPERATURE_DISPLAY_MODE,
  MATTER_THERMOSTAT_UI_CLUSTER,
} from './matter/constants.js';
import {
  MATTER_ACCESSORY_SCHEMA_VERSION,
  type Wave3MatterAccessoryContext,
} from './matter/context.js';
import {
  forgetAllDesiredAttributes,
  forgetDesiredCluster,
  forgetDesiredState,
  registerMatterControl,
  releaseMatterControlState,
  rememberDesiredCluster,
  rememberDesiredState,
  type Wave3MatterControl,
} from './matter/controlRegistry.js';
import { wave3RoomAirConditionerDeviceType } from './matter/deviceType.js';
import {
  centidegrees,
  clustersForSnapshot,
  electricalPowerMeasurementForSnapshot,
  normalizedAirflow,
  numberOrUndefined,
  systemModeForState,
} from './matter/projection.js';
import type { Wave3AccessoryController } from './wave3/controller.js';
import type {
  Wave3AirflowSpeed,
  Wave3Command,
  Wave3CommandFailure,
  Wave3ControllerSnapshot,
  Wave3Mode,
} from './wave3/domain.js';
import {
  constrainWave3AutomaticRange,
  planWave3TemperatureIntent,
} from './wave3/intentPlanner.js';

export { CACHED_STATE_MAX_AGE_MILLISECONDS, isRecentCachedState } from './matter/cachePolicy.js';
export { MATTER_SYSTEM_MODE } from './matter/constants.js';
export { wave3RoomAirConditionerDeviceType } from './matter/deviceType.js';

export interface MatterAccessoryBinding {
  stop(): void | Promise<void>;
}

export interface MatterAccessoryLogger {
  debug?(message: string): void;
  error(message: string): void;
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
  firstKind: 'heating' | 'cooling';
  heatingCelsius?: number;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

interface StagedThermostatIntent {
  revision: number;
  systemMode?: number;
  heatingCelsius?: number;
  coolingCelsius?: number;
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
    schemaVersion: MATTER_ACCESSORY_SCHEMA_VERSION,
    serialNumber: device.serialNumber,
    lastSystemMode: validSystemMode(cachedContext?.lastSystemMode)
      ?? MATTER_SYSTEM_MODE.cool,
    ...(
      snapshot.availability === 'online' && snapshot.updatedAt !== undefined
        ? { lastConfirmedAt: snapshot.updatedAt }
        : cachedContext?.lastConfirmedAt === undefined
          ? {}
          : { lastConfirmedAt: cachedContext.lastConfirmedAt }
    ),
    ...(firmwareRevision === undefined ? {} : { firmwareRevision }),
  };
  updateLastSystemMode(context, snapshot);
  const clusters = clustersForSnapshot(
    snapshot,
    context,
    cached?.clusters,
  );
  rememberDesiredState(uuid, clusters);
  return {
    UUID: uuid,
    displayName: device.name,
    deviceType: wave3RoomAirConditionerDeviceType(matter),
    manufacturer: 'EcoFlow',
    model: 'WAVE 3',
    serialNumber: device.serialNumber,
    ...(firmwareRevision === undefined ? {} : { firmwareRevision }),
    context,
    clusters,
  };
}

export function releaseWave3MatterAccessoryState(uuid: string): void {
  releaseMatterControlState(uuid);
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
  private presentedActivePower: number | null;
  private snapshot: Wave3ControllerSnapshot;
  private pendingFanWrite?: PendingFanWrite;
  private pendingTemperatureWrite?: PendingTemperatureWrite;
  private pendingPresentationUpdates = 1;
  private presentationRetryPending = false;
  private skippedSnapshotWhilePresentationPending?: Wave3ControllerSnapshot;
  private stagedThermostatIntent?: StagedThermostatIntent;
  private thermostatIntentRevision = 0;
  private thermostatCoordinator?: Promise<void>;
  private cacheExpiryTimer?: ReturnType<typeof setTimeout>;
  private presentedReachable = true;
  private stopped = false;

  constructor(
    private readonly matter: MatterAPI,
    private readonly accessory: MatterAccessory<Wave3MatterAccessoryContext>,
    private readonly controller: Wave3AccessoryController,
    private readonly logger: MatterAccessoryLogger = {
      debug: () => undefined,
      error: () => undefined,
    },
    private readonly now: () => number = Date.now,
    private readonly cachedStateMaxAgeMilliseconds = CACHED_STATE_MAX_AGE_MILLISECONDS,
  ) {
    this.snapshot = controller.snapshot;
    this.presentedActivePower = nullableFiniteNumber(
      accessory.clusters?.electricalPowerMeasurement?.activePower,
    );
    if (controller.snapshot.availability === 'online') {
      this.lastConfirmedSnapshot = controller.snapshot;
    }
    // Registration has completed before the binding is created. The desired
    // values used to admit asynchronous endpoint construction must not remain
    // as permanent exemptions for later controller writes.
    forgetDesiredState(accessory.UUID);
    registerMatterControl(accessory.UUID, this.createMatterControl());
    this.updateTail = this.pushElectricalPower(controller.snapshot).then(() => this.pushFirmware(
      controller.snapshot.firmwareVersions?.pd
      ?? controller.snapshot.firmwareVersions?.iot
      ?? accessory.context.firmwareRevision
      ?? accessory.firmwareRevision,
    )).then(async () => {
      await this.initializeReachability(controller.snapshot);
    }).then(() => {
      this.presentationRetryPending = false;
    }).catch(error => {
      this.presentationRetryPending = true;
      this.logger.error(`EcoFlow WAVE 3 Matter startup state update failed: ${errorMessage(error)}`);
    }).finally(() => this.finishPresentationUpdate());
    this.detachSnapshot = controller.onSnapshot(snapshot => {
      const previousSnapshot = this.snapshot;
      this.snapshot = snapshot;
      if (snapshot.availability === 'online') {
        this.lastConfirmedSnapshot = snapshot;
      }
      if (!this.presentationRetryPending
        && !matterPresentationChanged(previousSnapshot, snapshot)
        && !this.hasUnpresentedTrackedState(snapshot)) {
        if (this.pendingPresentationUpdates > 0) {
          this.skippedSnapshotWhilePresentationPending = snapshot;
        }
        return;
      }
      this.skippedSnapshotWhilePresentationPending = undefined;
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
    if (this.cacheExpiryTimer !== undefined) {
      clearTimeout(this.cacheExpiryTimer);
      this.cacheExpiryTimer = undefined;
    }
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
    this.cancelThermostatIntent();
    await Promise.allSettled([...this.activeCommands]);
    releaseMatterControlState(this.accessory.UUID);
    await this.updateTail;
    forgetDesiredState(this.accessory.UUID);
  }

  private createMatterControl(): Wave3MatterControl {
    return {
      setPower: (on, applyMatter) => {
        if (!on) {
          this.cancelPendingFan();
          this.cancelPendingTemperature();
          this.cancelThermostatIntent();
        }
        return this.runInteractiveCommand(
          'power',
          () => this.setPower(on, applyMatter),
        );
      },
      setSystemMode: systemMode => this.setSystemMode(systemMode),
      setHeatingSetpoint: value => this.setTemperatureSetpoint('heating', value),
      setCoolingSetpoint: value => this.setTemperatureSetpoint('cooling', value),
      raiseLowerSetpoint: (mode, amount) => this.runInteractiveCommand(
        'setpoint adjustment',
        async () => {
          await this.raiseLowerSetpoint(mode, amount);
          // The confirmed controller snapshot is the authoritative Matter
          // mutation. Calling Matter.js's local raise/lower afterward can
          // apply the delta twice if that snapshot has already landed.
        },
      ),
      setFanMode: fanMode => this.setFanMode(fanMode),
      setFanPercent: percent => this.setFanPercent(percent),
      setFanSpeed: speed => this.setFanSpeed(speed),
      setTemperatureDisplayMode: mode => this.setTemperatureDisplayMode(mode),
    };
  }

  private restoreConfirmedState(): void {
    if (this.stopped) {
      return;
    }
    if (this.lastConfirmedSnapshot === undefined) {
      return;
    }
    setImmediate(() => {
      if (this.stopped) {
        return;
      }
      this.updateTail = this.updateTail
        .then(() => {
          const latest = this.lastConfirmedSnapshot;
          return latest === undefined ? undefined : this.pushSnapshot(latest);
        })
        .catch(error => {
          this.logger.error(`EcoFlow WAVE 3 Matter state restoration failed: ${errorMessage(error)}`);
        });
    });
  }

  private async setPower(on: boolean, applyMatter: () => Promise<void>): Promise<void> {
    this.requireControllable();
    this.logger.debug?.(
      `EcoFlow diagnostics: Matter write power=${on} currentPower=${String(this.snapshot.state.powered)}`,
    );
    if (on) {
      if (!this.snapshot.state.powered) {
        await this.stageStartupMode();
        await this.execute({ type: 'power', on: true });
        this.logger.debug?.(
          'EcoFlow diagnostics: Matter power-on wake confirmed; re-planning staged thermostat intent',
        );
      }
      await this.coordinateThermostatIntent();
    } else if (this.snapshot.state.powered !== false) {
      await this.execute({ type: 'power', on: false });
    }
    await applyMatter();
  }

  private setSystemMode(systemMode: number): void {
    this.requireControllable();
    this.logger.debug?.(
      `EcoFlow diagnostics: Matter write systemMode=${systemMode} powered=${String(this.snapshot.state.powered)}`,
    );
    if (systemMode !== MATTER_SYSTEM_MODE.sleep
      && waveModeForSystemMode(systemMode) === undefined) {
      throw new MatterStatus.ConstraintError(`Unsupported Matter system mode ${systemMode}`);
    }
    if (systemMode === MATTER_SYSTEM_MODE.sleep && this.confirmedStateIsOff()) {
      throw new MatterStatus.InvalidInState('Sleep mode requires the WAVE 3 to be on');
    }
    this.stageThermostatIntent({ systemMode });
    if (this.confirmedStateIsOff()) {
      return;
    }
    this.trackAttributeCommand(
      this.scheduleThermostatCoordinator(),
      'system mode',
    );
  }

  private setTemperatureSetpoint(
    kind: 'heating' | 'cooling',
    value: number,
  ): void {
    this.requireControllable();
    const celsius = matterTemperature(value);
    this.logger.debug?.(
      `EcoFlow diagnostics: Matter write ${kind}SetpointCelsius=${celsius}`
      + ` mode=${String(this.snapshot.state.mode)}`
      + ` powered=${String(this.snapshot.state.powered)}`,
    );
    if (this.confirmedStateIsOff()) {
      this.stageThermostatIntent({
        ...(kind === 'heating'
          ? { heatingCelsius: celsius }
          : { coolingCelsius: celsius }),
      });
      return;
    }
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
    this.stageThermostatIntent({ heatingCelsius, coolingCelsius });
    await this.scheduleThermostatCoordinator();
  }

  private scheduleTemperatureSetpoint(
    kind: 'heating' | 'cooling',
    celsius: number,
  ): Promise<void> {
    if (this.pendingTemperatureWrite === undefined) {
      this.pendingTemperatureWrite = { firstKind: kind, waiters: [] };
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
      const mode = this.snapshot.state.mode;
      // Matter may move the active companion automatically to maintain its
      // global deadband after a controller writes the inactive setpoint. The
      // first callback identifies the controller's actual attribute; ignore
      // the coupled companion in single-mode operation.
      const heatingCelsius = mode === 'heat' && pending.firstKind === 'cooling'
        ? undefined
        : pending.heatingCelsius;
      const coolingCelsius = mode === 'cool' && pending.firstKind === 'heating'
        ? undefined
        : pending.coolingCelsius;
      await this.applyTemperatureSetpoints(
        heatingCelsius,
        coolingCelsius,
      );
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
    this.logger.debug?.(
      `EcoFlow diagnostics: Matter write setpointRaiseLower mode=${mode}`
      + ` amountTenthsCelsius=${amount} activeMode=${String(this.snapshot.state.mode)}`,
    );
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
        const [constrainedLower, constrainedUpper] = constrainWave3AutomaticRange(
          lowerCelsius,
          state.targetTemperatureUpperCelsius!,
          'lower',
        );
        await this.execute({
          type: 'automaticTemperatureRange',
          lowerCelsius: constrainedLower,
          upperCelsius: constrainedUpper,
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
        const [constrainedLower, constrainedUpper] = constrainWave3AutomaticRange(
          state.targetTemperatureLowerCelsius!,
          upperCelsius,
          'upper',
        );
        await this.execute({
          type: 'automaticTemperatureRange',
          lowerCelsius: constrainedLower,
          upperCelsius: constrainedUpper,
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
    this.logger.debug?.(`EcoFlow diagnostics: Matter write fanMode=${fanMode}`);
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
    this.logger.debug?.(`EcoFlow diagnostics: Matter write fanPercent=${String(percent)}`);
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
    this.logger.debug?.(`EcoFlow diagnostics: Matter write fanSpeed=${String(speed)}`);
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

  private setTemperatureDisplayMode(mode: number): void {
    this.requireControllable();
    const unit = mode === MATTER_TEMPERATURE_DISPLAY_MODE.celsius
      ? 'celsius'
      : mode === MATTER_TEMPERATURE_DISPLAY_MODE.fahrenheit
        ? 'fahrenheit'
        : undefined;
    if (unit === undefined) {
      throw new MatterStatus.ConstraintError(
        `Unsupported Matter temperature display mode ${mode}`,
      );
    }
    this.logger.debug?.(`EcoFlow diagnostics: Matter write temperatureDisplayUnit=${unit}`);
    if (this.snapshot.state.temperatureDisplayUnit === unit) {
      return;
    }
    this.trackAttributeCommand(
      this.enqueueControllerOperation(() => this.execute({
        type: 'temperatureDisplayUnit',
        unit,
      })),
      'temperature display mode',
    );
  }

  private trackAttributeCommand(command: Promise<void>, description: string): void {
    const tracked = command
      .catch(error => {
        if (!this.stopped) {
          this.logger.error(
            `EcoFlow WAVE 3 Matter ${description} command ${commandErrorOutcome(error)}: ${errorMessage(error)}`,
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
          `EcoFlow WAVE 3 Matter ${description} command ${commandErrorOutcome(error)}: ${errorMessage(error)}`,
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
    this.pendingPresentationUpdates += 1;
    this.updateTail = this.updateTail
      .then(async () => {
        try {
          await this.pushSnapshot(snapshot);
          this.presentationRetryPending = false;
        } catch (error) {
          this.presentationRetryPending = true;
          throw error;
        }
      })
      .catch(error => {
        if (!this.stopped && this.snapshot === snapshot) {
          this.logger.error(`EcoFlow WAVE 3 Matter state update failed: ${errorMessage(error)}`);
        }
      })
      .finally(() => this.finishPresentationUpdate());
  }

  private finishPresentationUpdate(): void {
    this.pendingPresentationUpdates -= 1;
    if (this.pendingPresentationUpdates > 0) {
      return;
    }
    const skippedSnapshot = this.skippedSnapshotWhilePresentationPending;
    this.skippedSnapshotWhilePresentationPending = undefined;
    if (!this.stopped && this.presentationRetryPending && skippedSnapshot !== undefined) {
      this.enqueueSnapshot(skippedSnapshot);
    }
  }

  private hasUnpresentedTrackedState(snapshot: Wave3ControllerSnapshot): boolean {
    const firmwareRevision = snapshot.firmwareVersions?.pd ?? snapshot.firmwareVersions?.iot;
    if (firmwareRevision !== undefined && firmwareRevision !== this.presentedFirmwareRevision) {
      return true;
    }
    return !Object.is(
      electricalPowerMeasurementForSnapshot(snapshot).activePower,
      this.presentedActivePower,
    );
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

  private cancelPendingTemperature(): void {
    const pending = this.pendingTemperatureWrite;
    if (pending === undefined) {
      return;
    }
    this.pendingTemperatureWrite = undefined;
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

    await this.pushElectricalPower(snapshot);

    if (snapshot.availability !== 'online') {
      await this.reconcileUnavailableSnapshot(snapshot);
      return;
    }

    this.cancelCacheExpiry();

    await this.pushFirmware(snapshot.firmwareVersions?.pd ?? snapshot.firmwareVersions?.iot);

    if (this.stopped) {
      return;
    }

    const clusters = this.clustersForPresentation(snapshot);
    this.accessory.clusters = clusters;
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.OnOff,
      clusters.onOff ?? {},
    );
    await this.pushThermostatState(clusters.thermostat ?? {});
    await this.updateState(
      this.accessory.UUID,
      MATTER_THERMOSTAT_UI_CLUSTER,
      clusters.thermostatUserInterfaceConfiguration ?? {},
    );
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.FanControl,
      clusters.fanControl ?? {},
    );
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.RelativeHumidityMeasurement,
      clusters.relativeHumidityMeasurement ?? {},
    );
    await this.pushReachability(true);
    this.accessory.context.lastConfirmedAt = this.now();
  }

  private async pushThermostatState(attributes: Record<string, unknown>): Promise<void> {
    let current: Record<string, unknown> | undefined;
    try {
      current = await this.matter.getAccessoryState(
        this.accessory.UUID,
        this.matter.clusterNames.Thermostat,
      );
    } catch {
      // A newly registering endpoint may not yet have readable state. The
      // conservative transition below is still valid.
    }
    if (current !== undefined && attributesMatch(current, attributes)) {
      return;
    }
    const remaining = current === undefined
      ? attributes
      : changedAttributes(current, attributes);
    if (Object.keys(remaining).length > 0) {
      await this.updateState(
        this.accessory.UUID,
        this.matter.clusterNames.Thermostat,
        remaining,
      );
    }
  }

  private async pushElectricalPower(snapshot: Wave3ControllerSnapshot): Promise<void> {
    const attributes = electricalPowerMeasurementForSnapshot(snapshot);
    const activePower = attributes.activePower;
    if (Object.is(activePower, this.presentedActivePower)) {
      return;
    }
    this.accessory.clusters = {
      ...this.accessory.clusters,
      electricalPowerMeasurement: {
        ...this.accessory.clusters?.electricalPowerMeasurement,
        ...attributes,
      },
    };
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.ElectricalPowerMeasurement,
      attributes,
    );
    this.presentedActivePower = activePower;
  }

  private async initializeReachability(snapshot: Wave3ControllerSnapshot): Promise<void> {
    if (snapshot.availability === 'online') {
      this.accessory.context.lastConfirmedAt = this.now();
      return;
    }
    if (this.hasRecentCachedState()) {
      this.scheduleCacheExpiry();
      return;
    }
    await this.pushReachability(false);
  }

  private async reconcileUnavailableSnapshot(
    snapshot: Wave3ControllerSnapshot,
  ): Promise<void> {
    if (snapshot.availability === 'offline' || snapshot.availability === 'accountError') {
      this.cancelCacheExpiry();
      await this.pushReachability(false);
      return;
    }
    if (this.hasRecentCachedState()) {
      this.scheduleCacheExpiry();
      return;
    }
    this.cancelCacheExpiry();
    await this.pushReachability(false);
  }

  private hasRecentCachedState(): boolean {
    return isRecentCachedState(
      this.accessory.context.lastConfirmedAt,
      this.now(),
      this.cachedStateMaxAgeMilliseconds,
    );
  }

  private scheduleCacheExpiry(): void {
    this.cancelCacheExpiry();
    const lastConfirmedAt = this.accessory.context.lastConfirmedAt;
    if (lastConfirmedAt === undefined) {
      return;
    }
    const remaining = Math.max(
      0,
      this.cachedStateMaxAgeMilliseconds - Math.max(0, this.now() - lastConfirmedAt),
    );
    this.cacheExpiryTimer = setTimeout(() => {
      this.cacheExpiryTimer = undefined;
      this.updateTail = this.updateTail.then(async () => {
        if (!this.stopped
          && this.snapshot.availability !== 'online'
          && !this.hasRecentCachedState()) {
          await this.pushReachability(false);
        }
      }).catch(error => {
        this.logger.error(`EcoFlow WAVE 3 Matter reachability update failed: ${errorMessage(error)}`);
      });
    }, remaining);
    this.cacheExpiryTimer.unref();
  }

  private cancelCacheExpiry(): void {
    if (this.cacheExpiryTimer !== undefined) {
      clearTimeout(this.cacheExpiryTimer);
      this.cacheExpiryTimer = undefined;
    }
  }

  private async pushReachability(reachable: boolean): Promise<void> {
    if (reachable === this.presentedReachable) {
      return;
    }
    await this.updateState(
      this.accessory.UUID,
      this.matter.clusterNames.BridgedDeviceBasicInformation,
      { reachable },
    );
    this.presentedReachable = reachable;
  }

  private confirmedStateIsOff(): boolean {
    return this.snapshot.state.powered === false || this.snapshot.state.mode === 'off';
  }

  private stageThermostatIntent(
    patch: Omit<Partial<StagedThermostatIntent>, 'revision'>,
  ): StagedThermostatIntent {
    const revision = ++this.thermostatIntentRevision;
    const intent: StagedThermostatIntent = {
      ...this.stagedThermostatIntent,
      revision,
    };
    if (patch.systemMode !== undefined) {
      intent.systemMode = patch.systemMode;
    }
    if (patch.heatingCelsius !== undefined) {
      intent.heatingCelsius = patch.heatingCelsius;
    }
    if (patch.coolingCelsius !== undefined) {
      intent.coolingCelsius = patch.coolingCelsius;
    }
    this.stagedThermostatIntent = intent;
    this.logger.debug?.(
      `EcoFlow diagnostics: staged Matter thermostat intent revision=${revision}`
      + ` systemMode=${String(intent.systemMode)}`
      + ` heatingCelsius=${String(intent.heatingCelsius)}`
      + ` coolingCelsius=${String(intent.coolingCelsius)}`,
    );
    return intent;
  }

  private cancelThermostatIntent(): void {
    if (this.stagedThermostatIntent !== undefined) {
      this.logger.debug?.(
        'EcoFlow diagnostics: cancelled staged Matter thermostat intent revision='
        + this.stagedThermostatIntent.revision,
      );
    }
    this.thermostatIntentRevision += 1;
    this.stagedThermostatIntent = undefined;
  }

  private async stageStartupMode(): Promise<void> {
    if (this.stagedThermostatIntent?.systemMode !== undefined) {
      return;
    }
    const presentedThermostat = await this.presentedThermostat();
    if (this.stagedThermostatIntent?.systemMode !== undefined) {
      return;
    }
    const systemMode = numberOrUndefined(presentedThermostat.systemMode)
      ?? this.accessory.context.lastSystemMode;
    if (systemMode !== undefined && waveModeForSystemMode(systemMode) !== undefined) {
      this.stageThermostatIntent({ systemMode });
    }
  }

  private scheduleThermostatCoordinator(): Promise<void> {
    const existing = this.thermostatCoordinator;
    if (existing !== undefined) {
      const continueWithLatestIntent = () => {
        if (this.stagedThermostatIntent !== undefined && !this.confirmedStateIsOff()) {
          return this.scheduleThermostatCoordinator();
        }
      };
      // A newer intent must not inherit the outcome of work it superseded.
      // The original caller still observes the old failure; this caller waits
      // for the latest revision to be planned after that operation settles.
      return existing.then(continueWithLatestIntent, continueWithLatestIntent);
    }
    const coordinator = this.enqueueControllerOperation(() => this.coordinateThermostatIntent());
    this.thermostatCoordinator = coordinator;
    void coordinator.then(
      () => {
        if (this.thermostatCoordinator === coordinator) {
          this.thermostatCoordinator = undefined;
        }
      },
      () => {
        if (this.thermostatCoordinator === coordinator) {
          this.thermostatCoordinator = undefined;
        }
      },
    );
    return coordinator;
  }

  private async coordinateThermostatIntent(): Promise<void> {
    while (this.stagedThermostatIntent !== undefined) {
      this.requireControllable();
      if (this.confirmedStateIsOff()) {
        return;
      }
      const intent = this.stagedThermostatIntent;
      const revision = intent.revision;
      try {
        if (intent.systemMode === MATTER_SYSTEM_MODE.sleep) {
          if (this.snapshot.state.submode !== 3) {
            await this.execute({ type: 'submode', submode: 3 });
          }
        } else {
          const requestedMode = intent.systemMode === undefined
            ? undefined
            : waveModeForSystemMode(intent.systemMode);
          if (intent.systemMode !== undefined && requestedMode === undefined) {
            throw new MatterStatus.ConstraintError(
              `Unsupported Matter system mode ${intent.systemMode}`,
            );
          }
          if (requestedMode !== undefined
            && (this.snapshot.state.submode === 2
              || this.snapshot.state.submode === 3
              || this.snapshot.state.submode === 4)) {
            await this.execute({ type: 'submode', submode: 0 });
          }
          if (this.thermostatIntentRevision !== revision) {
            this.logger.debug?.(
              `EcoFlow diagnostics: thermostat coordinator revision=${revision}`
              + ' superseded before mode application',
            );
            continue;
          }
          if (requestedMode !== undefined && this.snapshot.state.mode !== requestedMode) {
            this.logger.debug?.(
              `EcoFlow diagnostics: thermostat coordinator revision=${revision}`
              + ` applying mode=${requestedMode}`,
            );
            await this.execute({ type: 'mode', mode: requestedMode });
          }
          if (this.thermostatIntentRevision !== revision) {
            this.logger.debug?.(
              `EcoFlow diagnostics: thermostat coordinator revision=${revision}`
              + ' superseded after mode confirmation',
            );
            continue;
          }
          const activeMode = this.snapshot.state.mode;
          const hasActiveSetpoint = activeMode === 'heat'
            ? intent.heatingCelsius !== undefined
            : activeMode === 'cool'
              ? intent.coolingCelsius !== undefined
              : activeMode === 'auto'
                ? intent.heatingCelsius !== undefined || intent.coolingCelsius !== undefined
                : false;
          if (hasActiveSetpoint) {
            const plan = planWave3TemperatureIntent(this.snapshot.state, {
              heatingCelsius: intent.heatingCelsius,
              coolingCelsius: intent.coolingCelsius,
            });
            if (plan.status === 'command') {
              this.logger.debug?.(
                `EcoFlow diagnostics: thermostat coordinator revision=${revision}`
                + ` applying target after confirmed mode=${String(activeMode)}`,
              );
              await this.execute(plan.command);
            } else if (plan.status === 'missingAutomaticRange') {
              throw new MatterStatus.InvalidInState('Automatic temperature range is not yet known');
            } else if (plan.status === 'inactive') {
              throw new MatterStatus.InvalidInState(
                'The requested setpoint is inactive in the current mode',
              );
            }
          }
        }
      } catch (error) {
        if (this.thermostatIntentRevision !== revision
          && this.stagedThermostatIntent !== undefined
          && this.snapshot.availability === 'online') {
          continue;
        }
        throw error;
      }
      if (this.thermostatIntentRevision === revision) {
        this.stagedThermostatIntent = undefined;
        return;
      }
    }
  }

  private async presentedThermostat(): Promise<Record<string, unknown>> {
    let liveThermostat: Record<string, unknown> | undefined;
    try {
      liveThermostat = await this.matter.getAccessoryState(
        this.accessory.UUID,
        this.matter.clusterNames.Thermostat,
      );
    } catch {
      // Endpoint state may be temporarily unavailable during startup. The
      // cached presentation remains a safe fallback for a plain power-on.
    }
    return {
      ...this.accessory.clusters?.thermostat,
      ...liveThermostat,
    };
  }

  private clustersForPresentation(
    snapshot: Wave3ControllerSnapshot,
  ): NonNullable<MatterAccessory['clusters']> {
    updateLastSystemMode(this.accessory.context, snapshot);
    const clusters = clustersForSnapshot(
      snapshot,
      this.accessory.context,
      this.accessory.clusters,
    );
    const intent = this.stagedThermostatIntent;
    if (intent === undefined
      || (snapshot.state.powered !== false && snapshot.state.mode !== 'off')) {
      return clusters;
    }
    const thermostat = { ...clusters.thermostat };
    if (intent.systemMode !== undefined) {
      thermostat.systemMode = intent.systemMode;
    }
    if (intent.heatingCelsius !== undefined) {
      thermostat.occupiedHeatingSetpoint = centidegrees(intent.heatingCelsius);
    }
    if (intent.coolingCelsius !== undefined) {
      thermostat.occupiedCoolingSetpoint = centidegrees(intent.coolingCelsius);
    }
    const heating = numberOrUndefined(thermostat.occupiedHeatingSetpoint);
    const cooling = numberOrUndefined(thermostat.occupiedCoolingSetpoint);
    if (heating !== undefined && cooling !== undefined) {
      const [lower, upper] = constrainWave3AutomaticRange(
        heating / 100,
        cooling / 100,
        intent.heatingCelsius !== undefined && intent.coolingCelsius === undefined
          ? 'lower'
          : intent.coolingCelsius !== undefined && intent.heatingCelsius === undefined
            ? 'upper'
            : 'both',
      );
      thermostat.occupiedHeatingSetpoint = centidegrees(lower);
      thermostat.occupiedCoolingSetpoint = centidegrees(upper);
    }
    return { ...clusters, thermostat };
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
    } catch (error) {
      forgetDesiredCluster(uuid, cluster, attributes);
      throw error;
    }
    const confirmedAttributes = await waitForAttributes(this.matter, uuid, cluster, attributes);
    if (confirmedAttributes.size > 0) {
      forgetAllDesiredAttributes(uuid, cluster, confirmedAttributes);
    }
    // Homebridge 2.2.1 dispatches bridged state updates asynchronously and its
    // public promise can resolve before Matter.js applies them. If read-back
    // has not caught up, retain these values as internal-write markers. A
    // later Matter.js reaction consumes them, a newer snapshot safely adds its
    // own marker, and stop/release clears anything still pending.
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
    if ((await waitForAttributes(
      this.matter,
      this.accessory.UUID,
      cluster,
      attributes,
    )).size !== Object.keys(attributes).length) {
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

function attributesMatch(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([attribute, value]) => Object.is(current[attribute], value));
}

function matterPresentationChanged(
  previous: Wave3ControllerSnapshot,
  next: Wave3ControllerSnapshot,
): boolean {
  return previous.availability !== next.availability
    || previous.acPowerWatts !== next.acPowerWatts
    || previous.environmentTelemetryFresh !== next.environmentTelemetryFresh
    || previous.updatedAt !== next.updatedAt
    || !isDeepStrictEqual(previous.state, next.state)
    || !isDeepStrictEqual(previous.modeProfiles, next.modeProfiles)
    || !isDeepStrictEqual(previous.firmwareVersions, next.firmwareVersions);
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function changedAttributes(
  current: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(expected).filter(([key, value]) => !Object.is(current[key], value)),
  );
}

function updateLastSystemMode(
  context: Wave3MatterAccessoryContext,
  snapshot: Wave3ControllerSnapshot,
): void {
  if (snapshot.availability !== 'online') {
    return;
  }
  const systemMode = systemModeForState(snapshot.state.mode, snapshot.state.submode);
  if (systemMode !== undefined) {
    context.lastSystemMode = systemMode;
  }
}

function waveModeForSystemMode(systemMode: number): Exclude<Wave3Mode, 'off'> | undefined {
  switch (systemMode) {
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

function commandErrorOutcome(error: unknown): string {
  return error instanceof MatterStatus.Timeout ? 'confirmation timed out' : 'failed';
}

function matterErrorForFailure(reason: Wave3CommandFailure): Error {
  switch (reason) {
  case 'timeout':
    return new MatterStatus.Timeout('EcoFlow WAVE 3 did not confirm within the command deadline');
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
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  const expectedEntries = Object.entries(expected);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const state = await matter.getAccessoryState(uuid, cluster);
      if (state !== undefined) {
        for (const [attribute, value] of expectedEntries) {
          if (Object.is(state[attribute], value)) {
            confirmed.add(attribute);
          }
        }
        if (confirmed.size === expectedEntries.length) {
          return confirmed;
        }
      }
    } catch {
      // Retry while Homebridge finishes endpoint registration or a deferred update.
    }
    await delay(25);
  }
  return confirmed;
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

function validSystemMode(value: unknown): number | undefined {
  return typeof value === 'number' && value !== MATTER_SYSTEM_MODE.auto
    && Object.values(MATTER_SYSTEM_MODE).includes(
      value as (typeof MATTER_SYSTEM_MODE)[keyof typeof MATTER_SYSTEM_MODE],
    ) ? value : undefined;
}
