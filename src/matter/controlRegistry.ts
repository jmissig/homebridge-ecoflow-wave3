import type { MatterAccessory } from 'homebridge';

const DESIRED_MATTER_VALUE_TTL_MS = 30_000;

interface DesiredMatterValue {
  count: number;
  expiresAt: number;
  value: unknown;
}

export interface Wave3MatterControl {
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
  setTemperatureDisplayMode(mode: number): void;
}

const desiredMatterState = new Map<string, DesiredMatterValue[]>();
const matterControls = new Map<string, Wave3MatterControl>();

export function registerMatterControl(uuid: string, control: Wave3MatterControl): void {
  if (matterControls.has(uuid)) {
    throw new Error('Matter controls are already registered for this accessory');
  }
  matterControls.set(uuid, control);
}

export function releaseMatterControlState(uuid: string): void {
  matterControls.delete(uuid);
  forgetDesiredState(uuid);
}

export function rememberDesiredState(
  uuid: string,
  clusters: NonNullable<MatterAccessory['clusters']>,
): void {
  for (const [cluster, attributes] of Object.entries(clusters)) {
    rememberDesiredCluster(uuid, cluster, attributes);
  }
}

export function forgetDesiredState(uuid: string): void {
  const prefix = `${uuid}\u0000`;
  for (const key of desiredMatterState.keys()) {
    if (key.startsWith(prefix)) {
      desiredMatterState.delete(key);
    }
  }
}

export function rememberDesiredCluster(
  uuid: string,
  cluster: string,
  attributes: Record<string, unknown>,
): void {
  for (const [attribute, value] of Object.entries(attributes)) {
    if (!requiresMatterWriteGuard(cluster, attribute)) {
      continue;
    }
    const key = desiredStateKey(uuid, cluster, attribute);
    const values = desiredMatterState.get(key) ?? [];
    pruneExpiredDesiredValues(values);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (!Object.is(values[index]!.value, value)) {
        values.splice(index, 1);
      }
    }
    const existing = values.find(entry => Object.is(entry.value, value));
    if (existing === undefined) {
      values.push({ count: 1, expiresAt: Date.now() + DESIRED_MATTER_VALUE_TTL_MS, value });
    } else {
      existing.count += 1;
      existing.expiresAt = Date.now() + DESIRED_MATTER_VALUE_TTL_MS;
    }
    desiredMatterState.set(key, values);
  }
}

export function forgetDesiredCluster(
  uuid: string,
  cluster: string,
  attributes: Record<string, unknown>,
): void {
  for (const [attribute, value] of Object.entries(attributes)) {
    const key = desiredStateKey(uuid, cluster, attribute);
    const values = desiredMatterState.get(key);
    const index = values?.findIndex(entry => Object.is(entry.value, value)) ?? -1;
    if (values === undefined || index < 0) {
      continue;
    }
    const entry = values[index]!;
    entry.count -= 1;
    if (entry.count === 0) {
      values.splice(index, 1);
    }
    if (values.length === 0) {
      desiredMatterState.delete(key);
    }
  }
}

export function requireDesiredValueOrControl(
  uuid: string,
  cluster: string,
  attribute: string,
  value: unknown,
  control: (control: Wave3MatterControl) => void,
): boolean {
  const desired = { [attribute]: value };
  const key = desiredStateKey(uuid, cluster, attribute);
  const values = desiredMatterState.get(key);
  if (values !== undefined) {
    pruneExpiredDesiredValues(values);
    if (values.length === 0) {
      desiredMatterState.delete(key);
    }
  }
  if (values?.some(entry => Object.is(entry.value, value)) === true) {
    forgetDesiredCluster(uuid, cluster, desired);
    return false;
  }
  control(requireMatterControl(uuid));
  return true;
}

export function forgetAllDesiredAttributes(
  uuid: string,
  cluster: string,
  attributes: ReadonlySet<string>,
): void {
  for (const attribute of attributes) {
    desiredMatterState.delete(desiredStateKey(uuid, cluster, attribute));
  }
}

function pruneExpiredDesiredValues(values: DesiredMatterValue[]): void {
  const now = Date.now();
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index]!.expiresAt <= now) {
      values.splice(index, 1);
    }
  }
}

function requiresMatterWriteGuard(cluster: string, attribute: string): boolean {
  return (cluster === 'thermostat' && (
    attribute === 'systemMode'
    || attribute === 'occupiedHeatingSetpoint'
    || attribute === 'occupiedCoolingSetpoint'
  )) || (cluster === 'fanControl' && (
    attribute === 'fanMode'
    || attribute === 'percentSetting'
    || attribute === 'speedSetting'
  )) || (cluster === 'thermostatUserInterfaceConfiguration'
    && attribute === 'temperatureDisplayMode');
}

function desiredStateKey(uuid: string, cluster: string, attribute: string): string {
  return `${uuid}\u0000${cluster}\u0000${attribute}`;
}

export function requireMatterControl(uuid: string): Wave3MatterControl {
  const control = matterControls.get(uuid);
  if (control === undefined) {
    throw new Error('Matter controls are unavailable until command mapping is initialized');
  }
  return control;
}
