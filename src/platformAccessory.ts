import type { PlatformAccessory, Service } from 'homebridge';

import type { EcoFlowWave3Platform } from './platform.js';

/**
 * HomeKit presentation boundary for one EcoFlow WAVE 3.
 *
 * The initial template establishes the primary HeaterCooler service without
 * pretending that device state or commands are implemented.
 */
export class Wave3PlatformAccessory {
  public readonly heaterCoolerService: Service;

  constructor(
    private readonly platform: EcoFlowWave3Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'EcoFlow')
      .setCharacteristic(this.platform.Characteristic.Model, 'WAVE 3');

    this.heaterCoolerService = this.accessory.getService(this.platform.Service.HeaterCooler)
      ?? this.accessory.addService(
        this.platform.Service.HeaterCooler,
        this.accessory.displayName,
      );
  }
}
