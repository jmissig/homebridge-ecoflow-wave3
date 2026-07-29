import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { Wave3PlatformAccessory } from './platformAccessory.js';

/**
 * Homebridge dynamic-platform boundary for EcoFlow WAVE 3 accessories.
 *
 * Device discovery and transport are intentionally not implemented in the
 * template baseline.
 */
export class EcoFlowWave3Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories = new Map<string, PlatformAccessory>();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing EcoFlow WAVE 3 platform:', config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Homebridge finished launching; WAVE 3 discovery is not implemented yet');
    });
  }

  /**
   * Restore a cached accessory and reattach its HomeKit service handlers.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
    new Wave3PlatformAccessory(this, accessory);
  }
}
