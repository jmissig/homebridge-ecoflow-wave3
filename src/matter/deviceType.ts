import type { MatterAPI } from 'homebridge';

import { MATTER_FAN_MODE } from './constants.js';
import {
  forgetDesiredCluster,
  rememberDesiredCluster,
  requireDesiredValueOrControl,
  requireMatterControl,
} from './controlRegistry.js';
import { MATTER_THERMOSTAT_UI_CLUSTER } from './constants.js';
import { fanModeForAirflow } from './projection.js';

export function wave3RoomAirConditionerDeviceType(matter: MatterAPI) {
  // Device and behavior classes must come from the running Homebridge process.
  // A development `npm install -g .` symlinks this clone, whose dev dependency
  // may otherwise load a second Matter.js instance with incompatible class identity.
  const roomAirConditioner = matter.deviceTypes.RoomAirConditioner;
  const requirements = roomAirConditioner.requirements;
  const Wave3OnOffBase = requirements.OnOffServer;
  const Wave3ThermostatBase = requirements.ThermostatServer.with(
    'Heating',
    'Cooling',
    'AutoMode',
  );
  const MultiSpeedFanControlServer = requirements.FanControlServer.with('MultiSpeed');
  const Wave3ThermostatUiBase = requirements.ThermostatUserInterfaceConfigurationServer;

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
          fanMode: fanModeForAirflow(value),
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
          fanMode: fanModeForAirflow(percent),
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
      setImmediate(() => {
        forgetDesiredCluster(this.endpoint.id, 'fanControl', attributes);
      });
    }
  }

  class Wave3ThermostatUserInterfaceConfigurationServer extends Wave3ThermostatUiBase {
    override initialize(): void {
      super.initialize();
      this.reactTo(
        this.events.temperatureDisplayMode$Changing,
        value => {
          requireDesiredValueOrControl(
            this.endpoint.id,
            MATTER_THERMOSTAT_UI_CLUSTER,
            'temperatureDisplayMode',
            value,
            control => control.setTemperatureDisplayMode(value),
          );
        },
      );
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

  return roomAirConditioner.with(
    Wave3OnOffServer,
    Wave3ThermostatServer,
    Wave3FanControlServer,
    Wave3ThermostatUserInterfaceConfigurationServer,
    requirements.RelativeHumidityMeasurementServer,
  );
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
