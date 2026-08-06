import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  MatterAPI,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import {
  ConfigurationError,
  parseEcoFlowWave3Config,
  type EcoFlowWave3Config,
  type Wave3DeviceConfig,
} from './ecoflow/config.js';
import { NodeHttpsTransport } from './ecoflow/http.js';
import { MqttJsTransport } from './ecoflow/mqtt.js';
import { EcoFlowCloudSession } from './ecoflow/session.js';
import {
  MATTER_ACCESSORY_SCHEMA_VERSION,
  type Wave3MatterAccessoryContext,
} from './matter/context.js';
import {
  createWave3MatterAccessory,
  isRecentCachedState,
  releaseWave3MatterAccessoryState,
  Wave3MatterAccessory,
  type MatterAccessoryBinding,
} from './matterAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  Wave3Controller,
  type Wave3AccessoryController,
  type Wave3ControllerSession,
} from './wave3/controller.js';
import type { CloudSessionLogger } from './wave3/sessionPort.js';

export type { Wave3MatterAccessoryContext } from './matter/context.js';

export interface PlatformCloudSession extends Wave3ControllerSession {
  requestFullDisplayState(serialNumber: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface EcoFlowWave3PlatformDependencies {
  createSession(
    config: EcoFlowWave3Config,
    logger: CloudSessionLogger,
  ): PlatformCloudSession;
  createController(
    serialNumber: string,
    session: PlatformCloudSession,
    logger: CloudSessionLogger,
    freshnessTimeoutMilliseconds: number,
  ): Wave3AccessoryController;
  bindMatterAccessory(
    matter: MatterAPI,
    accessory: MatterAccessory<Wave3MatterAccessoryContext>,
    controller: Wave3AccessoryController,
    device: Wave3DeviceConfig,
    logger: CloudSessionLogger,
  ): MatterAccessoryBinding;
  matterRegistrationPollAttempts?: number;
  matterOperationPollAttempts?: number;
  waitForMatterOperationPoll?(): Promise<void>;
}

const DEFAULT_DEPENDENCIES: EcoFlowWave3PlatformDependencies = {
  createSession: (config, logger) => new EcoFlowCloudSession(
    config,
    new NodeHttpsTransport(),
    new MqttJsTransport(),
    logger,
  ),
  createController: (serialNumber, session, logger, freshnessTimeoutMilliseconds) => new Wave3Controller(
    serialNumber,
    session,
    { logger, staleAfterMilliseconds: freshnessTimeoutMilliseconds },
  ),
  bindMatterAccessory: (matter, accessory, controller, device, logger) => new Wave3MatterAccessory(
    matter,
    accessory,
    controller,
    logger,
  ),
};

/**
 * Homebridge 2 dynamic-platform boundary for explicitly configured WAVE 3
 * accessories.
 */
export class EcoFlowWave3Platform implements DynamicPlatformPlugin {
  public readonly matterAccessories = new Map<
    string,
    MatterAccessory<Wave3MatterAccessoryContext>
  >();
  public readonly matter?: MatterAPI;

  private readonly duplicateMatterAccessories: MatterAccessory<Wave3MatterAccessoryContext>[] = [];
  private readonly bindings = new Map<string, MatterAccessoryBinding>();
  private readonly controllers = new Map<string, Wave3AccessoryController>();
  private readonly parsedConfig?: EcoFlowWave3Config;
  private session?: PlatformCloudSession;
  private sessionStopPromise?: Promise<void>;
  private launchPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private shutdownStarted = false;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
    private readonly dependencies: EcoFlowWave3PlatformDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.matter = api.matter;

    try {
      const parsedConfig = parseEcoFlowWave3Config(config);
      if (!api.isMatterEnabled() || this.matter === undefined) {
        this.log.error(
          'EcoFlow WAVE 3 is Matter-only; enable Matter and disable HAP for this child bridge',
        );
      } else {
        this.parsedConfig = parsedConfig;
        this.log.debug('Validated EcoFlow WAVE 3 platform configuration');
      }
    } catch (error) {
      const detail = error instanceof ConfigurationError ? error.message : 'unexpected configuration error';
      this.log.error(`EcoFlow WAVE 3 configuration is invalid: ${detail}`);
    }

    this.api.on('didFinishLaunching', () => {
      void this.launch();
    });
    this.api.on('shutdown', () => {
      void this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    void accessory;
  }

  /** Record Matter cache entries before launch for reconciliation by UUID. */
  configureMatterAccessory(accessory: MatterAccessory): void {
    const typedAccessory = accessory as MatterAccessory<Wave3MatterAccessoryContext>;
    const existing = this.matterAccessories.get(accessory.UUID);
    if (existing === accessory) {
      return;
    }
    if (existing !== undefined) {
      this.duplicateMatterAccessories.push(typedAccessory);
      this.log.warn('Ignoring a duplicate cached Matter WAVE 3 accessory');
      return;
    }
    this.matterAccessories.set(accessory.UUID, typedAccessory);
    this.log.debug('Recorded a cached Matter WAVE 3 accessory');
  }

  async launch(): Promise<void> {
    if (this.shutdownStarted) {
      return;
    }
    if (this.launchPromise !== undefined) {
      return this.launchPromise;
    }
    this.launchPromise = this.launchPlatform();
    return this.launchPromise;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }
    this.shutdownStarted = true;
    this.shutdownPromise = this.shutdownPlatform();
    return this.shutdownPromise;
  }

  private async launchPlatform(): Promise<void> {
    try {
      await this.launchPlatformUnsafe();
    } catch {
      if (!this.shutdownStarted) {
        this.log.error('EcoFlow WAVE 3 Matter platform setup failed');
      }
      await this.cleanupFailedLaunch();
    }
  }

  private async launchPlatformUnsafe(): Promise<void> {
    if (this.parsedConfig === undefined) {
      return;
    }

    const desiredUuids = new Set(
      this.parsedConfig.devices.map(device => this.uuidForSerial(device.serialNumber)),
    );
    const staleMatterAccessories = [
      ...this.duplicateMatterAccessories,
      ...[...this.matterAccessories.values()].filter(accessory => !desiredUuids.has(accessory.UUID)),
    ];
    if (staleMatterAccessories.length > 0) {
      await this.matter!.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        staleMatterAccessories,
      );
      const removed = await this.waitForMatterUnregistration(
        staleMatterAccessories.map(accessory => accessory.UUID),
      );
      if (!removed) {
        if (!this.shutdownStarted) {
          this.log.error('EcoFlow WAVE 3 stale Matter endpoint removal did not complete');
        }
        return;
      }
      for (const accessory of staleMatterAccessories) {
        if (this.matterAccessories.get(accessory.UUID) === accessory) {
          this.matterAccessories.delete(accessory.UUID);
        }
      }
      this.log.info(`Removed ${staleMatterAccessories.length} stale Matter WAVE 3 accessory record(s)`);
    }

    if (this.shutdownStarted) {
      return;
    }

    const logger = cloudLogger(this.log);
    const session = this.dependencies.createSession(this.parsedConfig, logger);
    this.session = session;
    const devicesNeedingFullDisplayState: string[] = [];

    for (const device of this.parsedConfig.devices) {
      if (this.shutdownStarted) {
        break;
      }
      const uuid = this.uuidForSerial(device.serialNumber);
      const cachedAccessory = this.matterAccessories.get(uuid);
      const endpointShapeChanged = cachedAccessory !== undefined
        && cachedAccessory.context.schemaVersion !== MATTER_ACCESSORY_SCHEMA_VERSION;
      if (endpointShapeChanged
        || !isRecentCachedState(cachedAccessory?.context.lastConfirmedAt)) {
        devicesNeedingFullDisplayState.push(device.serialNumber);
      }
      if (endpointShapeChanged) {
        await this.matter!.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          [cachedAccessory],
        );
        const removed = await this.waitForMatterUnregistration([uuid]);
        if (!removed) {
          if (!this.shutdownStarted) {
            this.log.error('EcoFlow WAVE 3 Matter endpoint replacement could not remove the old shape');
          }
          await this.stopSession();
          return;
        }
        this.matterAccessories.delete(uuid);
        if (this.shutdownStarted) {
          break;
        }
      }

      const controller = this.dependencies.createController(
        device.serialNumber,
        session,
        logger,
        this.parsedConfig.freshnessTimeoutMinutes * 60_000,
      );
      this.controllers.set(uuid, controller);
      const accessory = createWave3MatterAccessory(
        this.matter!,
        uuid,
        device,
        controller.snapshot,
        endpointShapeChanged ? undefined : cachedAccessory,
      );
      this.matterAccessories.set(uuid, accessory);
      await this.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      const registered = await this.waitForMatterRegistration(accessory);
      if (this.shutdownStarted || !registered) {
        this.stopController(uuid, controller);
        this.matterAccessories.delete(uuid);
        await this.cleanupDispatchedRegistration(accessory);
        releaseWave3MatterAccessoryState(uuid);
        if (!this.shutdownStarted) {
          this.log.error('EcoFlow WAVE 3 Matter endpoint registration did not complete');
          throw new Error('Matter endpoint registration did not complete');
        }
        await this.stopSession();
        return;
      }
      if (cachedAccessory === undefined || endpointShapeChanged) {
        this.log.info('Registered a configured Matter WAVE 3 accessory');
      } else {
        this.log.info('Restored a configured Matter WAVE 3 accessory from cache');
      }

      const binding = this.dependencies.bindMatterAccessory(
        this.matter!,
        accessory,
        controller,
        device,
        logger,
      );
      this.bindings.set(uuid, binding);
    }

    if (this.shutdownStarted) {
      await this.stopSession();
      return;
    }
    try {
      await session.start();
    } catch {
      if (!this.shutdownStarted) {
        this.log.error('EcoFlow WAVE 3 cloud session failed to start');
      }
      return;
    }
    for (const serialNumber of devicesNeedingFullDisplayState) {
      try {
        await session.requestFullDisplayState(serialNumber);
      } catch {
        if (!this.shutdownStarted) {
          this.log.error('EcoFlow WAVE 3 one-off full display-state request failed');
        }
        break;
      }
    }
  }

  private async shutdownPlatform(): Promise<void> {
    await this.stopRuntimeResources();
    await this.launchPromise;
    await this.stopRuntimeResources();
  }

  private async stopRuntimeResources(): Promise<void> {
    for (const [uuid, controller] of this.controllers) {
      this.stopController(uuid, controller);
    }
    await Promise.allSettled([...this.bindings.values()].map(binding => binding.stop()));
    this.bindings.clear();
    try {
      await this.stopSession();
    } catch {
      this.log.error('EcoFlow WAVE 3 cloud session failed to stop cleanly');
    }
  }

  private stopController(uuid: string, controller: Wave3AccessoryController): void {
    if (this.controllers.get(uuid) !== controller) {
      return;
    }
    this.controllers.delete(uuid);
    try {
      controller.stop();
    } catch {
      this.log.error('EcoFlow WAVE 3 controller failed to stop cleanly');
    }
  }

  private async cleanupFailedLaunch(): Promise<void> {
    await this.stopRuntimeResources();
    const accessories = [...this.matterAccessories.values()];
    if (accessories.length === 0) {
      return;
    }
    for (const accessory of accessories) {
      releaseWave3MatterAccessoryState(accessory.UUID);
    }
    try {
      await this.matter!.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        accessories,
      );
      if (!await this.waitForMatterUnregistration(accessories.map(accessory => accessory.UUID))) {
        this.log.error('EcoFlow WAVE 3 Matter cleanup did not remove all endpoints after setup failure');
        return;
      }
      for (const accessory of accessories) {
        if (this.matterAccessories.get(accessory.UUID) === accessory) {
          this.matterAccessories.delete(accessory.UUID);
        }
      }
    } catch {
      this.log.error('EcoFlow WAVE 3 Matter cleanup failed after setup failure');
    }
  }

  private async stopSession(): Promise<void> {
    if (this.session === undefined) {
      return;
    }
    this.sessionStopPromise ??= this.session.stop();
    await this.sessionStopPromise;
  }

  private async waitForMatterRegistration(
    accessory: MatterAccessory<Wave3MatterAccessoryContext>,
  ): Promise<boolean> {
    const maxAttempts = this.dependencies.matterRegistrationPollAttempts ?? 60;
    for (let attempts = 0; attempts < maxAttempts && !this.shutdownStarted; attempts += 1) {
      await this.waitForMatterRegistrationProbe();
      if (this.shutdownStarted) {
        return false;
      }
      try {
        const onOff = await this.matter!.getAccessoryState(
          accessory.UUID,
          this.matter!.clusterNames.OnOff,
        );
        if (onOff === undefined) {
          if (attempts === 29) {
            this.log.warn('Still waiting for Homebridge to finish Matter endpoint registration');
          }
          continue;
        }
        const humidity = await this.matter!.getAccessoryState(
          accessory.UUID,
          this.matter!.clusterNames.RelativeHumidityMeasurement,
        );
        if (humidity === undefined) {
          if (attempts === 29) {
            this.log.warn('Still waiting for Homebridge to finish Matter endpoint registration');
          }
          continue;
        }
        return true;
      } catch {
        // Homebridge reports a missing endpoint while bridged registration is still in flight.
      }
      if (attempts === 29) {
        this.log.warn('Still waiting for Homebridge to finish Matter endpoint registration');
      }
    }
    return false;
  }

  private async waitForMatterRegistrationProbe(): Promise<void> {
    // Homebridge 2.2.1 dispatches bridged registration asynchronously despite the
    // public API promise. Probe sparsely because each getAccessoryState call is
    // echoed into Homebridge's global debug log while the endpoint is absent.
    for (let interval = 0; interval < 40 && !this.shutdownStarted; interval += 1) {
      await this.waitForMatterOperationPoll();
    }
  }

  private async waitForMatterUnregistration(uuids: readonly string[]): Promise<boolean> {
    const maxAttempts = this.dependencies.matterOperationPollAttempts ?? 200;
    for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
      const states = await Promise.all(uuids.map(async uuid => {
        try {
          return await this.matter!.getAccessoryState(uuid, this.matter!.clusterNames.OnOff);
        } catch {
          return undefined;
        }
      }));
      if (states.every(state => state === undefined)) {
        return true;
      }
      if (attempts === 199) {
        this.log.warn('Still waiting for Homebridge to finish Matter endpoint removal');
      }
      await this.waitForMatterOperationPoll();
    }
    return false;
  }

  private async cleanupDispatchedRegistration(
    accessory: MatterAccessory<Wave3MatterAccessoryContext>,
  ): Promise<void> {
    const maxAttempts = this.dependencies.matterOperationPollAttempts ?? 200;
    try {
      // Registration is dispatched asynchronously by Homebridge. Cancel it
      // immediately even when the endpoint is not readable yet, then keep
      // watching for a late registration that needs a second removal.
      await this.matter!.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        [accessory],
      );
    } catch {
      // The bounded observation loop below still catches a late endpoint.
    }
    for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
      try {
        if (await this.matter!.getAccessoryState(
          accessory.UUID,
          this.matter!.clusterNames.OnOff,
        ) !== undefined) {
          await this.matter!.unregisterPlatformAccessories(
            PLUGIN_NAME,
            PLATFORM_NAME,
            [accessory],
          );
          await this.waitForMatterUnregistration([accessory.UUID]);
          return;
        }
      } catch {
        // Keep watching for a dispatched registration that has not materialized yet.
      }
      if (attempts === 199) {
        this.log.warn('Still waiting to clean a dispatched Matter endpoint registration');
      }
      await this.waitForMatterOperationPoll();
    }
    this.log.warn('Stopped waiting for a dispatched Matter endpoint registration to materialize');
  }

  private async waitForMatterOperationPoll(): Promise<void> {
    if (this.dependencies.waitForMatterOperationPoll !== undefined) {
      await this.dependencies.waitForMatterOperationPoll();
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }

  private uuidForSerial(serialNumber: string): string {
    if (this.matter === undefined) {
      throw new Error('Matter API is unavailable');
    }
    return this.matter.uuid.generate(`${PLUGIN_NAME}:wave3:${serialNumber}`);
  }
}

function cloudLogger(log: Logging): CloudSessionLogger {
  return {
    debug: message => log.debug(message),
    info: message => log.info(message),
    warn: message => log.warn(message),
    error: message => log.error(message),
  };
}
