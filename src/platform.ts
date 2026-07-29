import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import {
  ConfigurationError,
  parseEcoFlowWave3Config,
  type EcoFlowWave3Config,
} from './ecoflow/config.js';
import { NodeHttpsTransport } from './ecoflow/http.js';
import { MqttJsTransport } from './ecoflow/mqtt.js';
import {
  EcoFlowCloudSession,
  type CloudSessionLogger,
} from './ecoflow/session.js';
import {
  Wave3PlatformAccessory,
  type Wave3AccessoryController,
} from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  Wave3Controller,
  type Wave3ControllerSession,
} from './wave3/controller.js';

export interface Wave3AccessoryContext {
  schemaVersion: 1;
  serialNumber: string;
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
  ): Wave3AccessoryController;
  bindAccessory(
    platform: EcoFlowWave3Platform,
    accessory: PlatformAccessory<Wave3AccessoryContext>,
    controller: Wave3AccessoryController,
  ): Wave3PlatformAccessory;
}

const DEFAULT_DEPENDENCIES: EcoFlowWave3PlatformDependencies = {
  createSession: (config, logger) => new EcoFlowCloudSession(
    config,
    new NodeHttpsTransport(),
    new MqttJsTransport(),
    logger,
  ),
  createController: (serialNumber, session) => new Wave3Controller(
    serialNumber,
    session,
  ),
  bindAccessory: (platform, accessory, controller) => new Wave3PlatformAccessory(
    platform,
    accessory,
    controller,
  ),
};

/**
 * Homebridge 2 dynamic-platform boundary for explicitly configured WAVE 3
 * accessories.
 */
export class EcoFlowWave3Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories = new Map<string, PlatformAccessory>();

  private readonly duplicateAccessories: PlatformAccessory[] = [];
  private readonly bindings = new Map<string, Wave3PlatformAccessory>();
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

    try {
      this.parsedConfig = parseEcoFlowWave3Config(config);
      this.log.debug('Validated EcoFlow WAVE 3 platform configuration');
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
    const staleAccessories = [
      ...this.duplicateAccessories,
      ...[...this.accessories.values()].filter(accessory => !desiredUuids.has(accessory.UUID)),
    ];
    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        staleAccessories,
      );
      for (const accessory of staleAccessories) {
        if (this.accessories.get(accessory.UUID) === accessory) {
          this.accessories.delete(accessory.UUID);
        }
      }
      this.log.info(`Removed ${staleAccessories.length} stale WAVE 3 accessory record(s)`);
    }

    const logger = cloudLogger(this.log);
    const session = this.dependencies.createSession(this.parsedConfig, logger);
    this.session = session;

    for (const device of this.parsedConfig.devices) {
      const uuid = this.uuidForSerial(device.serialNumber);
      let accessory = this.accessories.get(uuid) as PlatformAccessory<Wave3AccessoryContext> | undefined;
      if (accessory === undefined) {
        accessory = new this.api.platformAccessory<Wave3AccessoryContext>(
          device.name,
          uuid,
        );
        this.accessories.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info('Registered a configured WAVE 3 accessory');
      } else {
        accessory.updateDisplayName(device.name);
        this.log.info('Restored a configured WAVE 3 accessory from cache');
      }

      accessory.context = {
        schemaVersion: 1,
        serialNumber: device.serialNumber,
      };
      this.api.updatePlatformAccessories([accessory]);

      const controller = this.dependencies.createController(device.serialNumber, session);
      const binding = this.dependencies.bindAccessory(this, accessory, controller);
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
    return this.api.hap.uuid.generate(`${PLUGIN_NAME}:wave3:${serialNumber}`);
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
