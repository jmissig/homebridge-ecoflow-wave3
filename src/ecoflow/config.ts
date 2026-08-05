export const REVIEWED_API_HOSTS = [
  'api.ecoflow.com',
  'api-a.ecoflow.com',
  'api-e.ecoflow.com',
] as const;

export type ReviewedApiHost = typeof REVIEWED_API_HOSTS[number];

export interface Wave3DeviceConfig {
  name: string;
  serialNumber: string;
}

export interface EcoFlowWave3Config {
  name: string;
  email: string;
  password: string;
  apiHost: string;
  freshnessTimeoutMinutes: number;
  devices: readonly Wave3DeviceConfig[];
}

export const DEFAULT_FRESHNESS_TIMEOUT_MINUTES = 5;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const HOMEKIT_NAME_PATTERN =
  /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]*[\p{L}\p{N}]$/u;

export function parseEcoFlowWave3Config(value: unknown): EcoFlowWave3Config {
  const config = requireRecord(value, 'configuration');
  rejectUnknownKeys(config, [
    'name',
    'email',
    'password',
    'apiHost',
    'advancedApiHostOverride',
    'freshnessTimeoutMinutes',
    'devices',
    'platform',
  ]);

  const name = requireString(config, 'name', { maxLength: 64 });
  validateDisplayName(name, 'name');
  const email = requireString(config, 'email', { maxLength: 320, trim: false });
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new ConfigurationError('email must be a valid account address');
  }
  const password = requireString(config, 'password');
  const reviewedHost = requireString(config, 'apiHost', { trim: false });
  const advancedOverride = optionalString(config, 'advancedApiHostOverride');
  const apiHost = validateApiHost(reviewedHost, advancedOverride);
  const freshnessTimeoutMinutes = optionalInteger(
    config,
    'freshnessTimeoutMinutes',
    1,
    60,
  ) ?? DEFAULT_FRESHNESS_TIMEOUT_MINUTES;

  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    throw new ConfigurationError('devices must contain at least one explicitly configured WAVE 3');
  }

  const seenSerials = new Set<string>();
  const devices = config.devices.map((candidate, index) => {
    const device = requireRecord(candidate, `devices[${index}]`);
    rejectUnknownKeys(device, ['name', 'serialNumber']);
    const deviceName = requireString(device, 'name', { maxLength: 64 });
    validateDisplayName(deviceName, `devices[${index}].name`);
    const serialNumber = requireString(device, 'serialNumber', { maxLength: 64, trim: false });
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(serialNumber)) {
      throw new ConfigurationError(`devices[${index}].serialNumber has an invalid format`);
    }
    if (seenSerials.has(serialNumber)) {
      throw new ConfigurationError(`devices[${index}].serialNumber is duplicated`);
    }
    seenSerials.add(serialNumber);
    return Object.freeze({ name: deviceName, serialNumber });
  });

  return Object.freeze({
    name,
    email,
    password,
    apiHost,
    freshnessTimeoutMinutes,
    devices: Object.freeze(devices),
  });
}

function validateApiHost(reviewedHost: string, advancedOverride: string | undefined): string {
  if (!REVIEWED_API_HOSTS.includes(reviewedHost as ReviewedApiHost)) {
    throw new ConfigurationError('apiHost must be a reviewed EcoFlow regional endpoint');
  }
  if (advancedOverride !== undefined) {
    if (!isHostname(advancedOverride)) {
      throw new ConfigurationError('advancedApiHostOverride must be a hostname without a scheme, port, or path');
    }
    return advancedOverride.toLowerCase();
  }
  return reviewedHost;
}

function isHostname(value: string): boolean {
  const labels = value.split('.');
  if (value.length > 253
    || value.toLowerCase() === 'localhost'
    || !/[A-Za-z]/.test(labels.at(-1) ?? '')) {
    return false;
  }
  try {
    const url = new URL(`https://${value}`);
    const labelsAreValid = labels.every(label => (
      label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ));
    return labelsAreValid
      && url.hostname === value.toLowerCase()
      && url.port === ''
      && url.pathname === '/'
      && !url.username
      && !url.password
      && value.includes('.');
  } catch {
    return false;
  }
}

function validateDisplayName(value: string, field: string): void {
  if (!HOMEKIT_NAME_PATTERN.test(value)) {
    throw new ConfigurationError(
      `${field} must be an Apple Home-safe name that starts and ends with a letter or number`,
    );
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(record).find(key => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new ConfigurationError(`configuration contains unsupported field ${unknown}`);
  }
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; trim?: boolean } = {},
): string {
  const value = record[field];
  if (typeof value !== 'string'
    || (field === 'password' ? value.length === 0 : value.trim().length === 0)) {
    throw new ConfigurationError(`${field} must be a non-empty string`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ConfigurationError(`${field} is too long`);
  }
  return field === 'password' || options.trim === false ? value : value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ConfigurationError(`${field} must be a string`);
  }
  if (value !== value.trim()) {
    throw new ConfigurationError(`${field} must not contain surrounding whitespace`);
  }
  return value;
}

function optionalInteger(
  record: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ConfigurationError(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}
