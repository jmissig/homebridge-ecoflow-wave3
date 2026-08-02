import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  MatterAPI,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import {
  ConfigurationError,
  parseEcoFlowWave3Config,
  type EcoFlowWave3Config,
  type Wave3DeviceConfig,
} from './ecoflow/config.js';
import { NodeHttpsTransport } from './ecoflow/http.js';
import { MqttJsTransport } from './ecoflow/mqtt.js';
import {
  EcoFlowCloudSession,
  type CloudSessionLogger,
} from './ecoflow/session.js';
import {
  type Wave3AccessoryController,
} from './platformAccessory.js';
import {
  createWave3MatterAccessory,
  Wave3MatterAccessory,
  type MatterAccessoryBinding,
} from './matterAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  Wave3Controller,
  type Wave3ControllerSession,
} from './wave3/controller.js';

export interface Wave3AccessoryContext {
  schemaVersion: 1;
  serialNumber: string;
  lastTargetMode?: 'auto' | 'cool' | 'heat';
}

export interface Wave3MatterAccessoryContext {
  schemaVersion: 1;
  serialNumber: string;
  currentTemperatureSource: Wave3DeviceConfig['currentTemperatureSource'];
  lastSystemMode?: number;
}

export interface PlatformCloudSession extends Wave3ControllerSession {
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
  ): Wave3AccessoryController;
  bindMatterAccessory(
    matter: MatterAPI,
    accessory: MatterAccessory<Wave3MatterAccessoryContext>,
    controller: Wave3AccessoryController,
    device: Wave3DeviceConfig,
    logger: CloudSessionLogger,
  ): MatterAccessoryBinding;
}

const DEFAULT_DEPENDENCIES: EcoFlowWave3PlatformDependencies = {
  createSession: (config, logger) => new EcoFlowCloudSession(
    config,
    new NodeHttpsTransport(),
    new MqttJsTransport(),
    logger,
  ),
  createController: (serialNumber, session, logger) => new Wave3Controller(
    serialNumber,
    session,
    { logger },
  ),
  bindMatterAccessory: (matter, accessory, controller, device, logger) => new Wave3MatterAccessory(
    matter,
    accessory,
    controller,
    device.currentTemperatureSource,
    logger,
  ),
};

/**
 * Homebridge 2 dynamic-platform boundary for explicitly configured WAVE 3
 * accessories.
 */
export class EcoFlowWave3Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly homeKitWriteSettleMilliseconds = 750;
  public readonly accessories = new Map<string, PlatformAccessory>();
  public readonly matterAccessories = new Map<
    string,
    MatterAccessory<Wave3MatterAccessoryContext>
  >();
  public readonly matter?: MatterAPI;

  private readonly duplicateAccessories: PlatformAccessory[] = [];
  private readonly duplicateMatterAccessories: MatterAccessory<Wave3MatterAccessoryContext>[] = [];
  private readonly bindings = new Map<string, MatterAccessoryBinding>();
  private readonly controllers = new Map<string, Wave3AccessoryController>();
  private readonly parsedConfig?: EcoFlowWave3Config;
  private session?: PlatformCloudSession;
  private launchPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private shutdownStarted = false;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
    private readonly dependencies: EcoFlowWave3PlatformDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.matter = api.matter;

    try {
      const parsedConfig = parseEcoFlowWave3Config(config);
      if (!api.isMatterEnabled() || this.matter === undefined) {
        this.log.error(
          'EcoFlow WAVE 3 requires Matter to be enabled for this child bridge; '
          + 'HAP fallback is not supported',
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

  /**
   * Record cached accessories. Controllers and HomeKit handlers are attached
   * only after Homebridge has finished restoring the complete cache.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    const existing = this.accessories.get(accessory.UUID);
    if (existing === accessory) {
      return;
    }
    if (existing !== undefined) {
      this.duplicateAccessories.push(accessory);
      this.log.warn('Ignoring a duplicate cached WAVE 3 accessory');
      return;
    }
    this.accessories.set(accessory.UUID, accessory);
    this.log.debug('Recorded a cached WAVE 3 accessory');
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
      for (const accessory of staleMatterAccessories) {
        if (this.matterAccessories.get(accessory.UUID) === accessory) {
          this.matterAccessories.delete(accessory.UUID);
        }
      }
      this.log.info(`Removed ${staleMatterAccessories.length} stale Matter WAVE 3 accessory record(s)`);
    }

    const logger = cloudLogger(this.log);
    const session = this.dependencies.createSession(this.parsedConfig, logger);
    this.session = session;

    for (const device of this.parsedConfig.devices) {
      const uuid = this.uuidForSerial(device.serialNumber);
      const cachedAccessory = this.matterAccessories.get(uuid);
      const sourceChanged = cachedAccessory !== undefined
        && cachedAccessory.context.currentTemperatureSource !== device.currentTemperatureSource;
      if (sourceChanged) {
        await this.matter!.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          [cachedAccessory],
        );
        this.matterAccessories.delete(uuid);
      }

      const controller = this.dependencies.createController(device.serialNumber, session, logger);
      const accessory = createWave3MatterAccessory(
        this.matter!,
        uuid,
        device,
        controller.snapshot,
        sourceChanged ? undefined : cachedAccessory,
      );
      this.matterAccessories.set(uuid, accessory);
      await this.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      if (cachedAccessory === undefined || sourceChanged) {
        this.log.info('Registered a configured Matter WAVE 3 accessory');
      } else {
        await this.matter!.updatePlatformAccessories([accessory]);
        this.log.info('Restored a configured Matter WAVE 3 accessory from cache');
      }

      const binding = this.dependencies.bindMatterAccessory(
        this.matter!,
        accessory,
        controller,
        device,
        logger,
      );
      this.controllers.set(uuid, controller);
      this.bindings.set(uuid, binding);
    }

    try {
      await session.start();
    } catch {
      if (!this.shutdownStarted) {
        this.log.error('EcoFlow WAVE 3 cloud session failed to start');
      }
    }
  }

  private async shutdownPlatform(): Promise<void> {
    for (const binding of this.bindings.values()) {
      binding.stop();
    }
    this.bindings.clear();
    for (const controller of this.controllers.values()) {
      controller.stop();
    }
    this.controllers.clear();
    await this.session?.stop();
    await this.launchPromise;
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
