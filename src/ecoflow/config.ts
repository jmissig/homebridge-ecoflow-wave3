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
  devices: readonly Wave3DeviceConfig[];
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function parseEcoFlowWave3Config(value: unknown): EcoFlowWave3Config {
  const config = requireRecord(value, 'configuration');
  rejectUnknownKeys(config, [
    'name',
    'email',
    'password',
    'apiHost',
    'advancedApiHostOverride',
    'devices',
    'platform',
  ]);

  const name = requireString(config, 'name', { maxLength: 64 });
  const email = requireString(config, 'email', { maxLength: 320 });
  if (!email.includes('@')) {
    throw new ConfigurationError('email must be a valid account address');
  }
  const password = requireString(config, 'password');
  const reviewedHost = requireString(config, 'apiHost');
  const advancedOverride = optionalString(config, 'advancedApiHostOverride');
  const apiHost = validateApiHost(reviewedHost, advancedOverride);

  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    throw new ConfigurationError('devices must contain at least one explicitly configured WAVE 3');
  }

  const seenSerials = new Set<string>();
  const devices = config.devices.map((candidate, index) => {
    const device = requireRecord(candidate, `devices[${index}]`);
    rejectUnknownKeys(device, ['name', 'serialNumber']);
    const deviceName = requireString(device, 'name', { maxLength: 64 });
    const serialNumber = requireString(device, 'serialNumber', { maxLength: 64 });
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
    devices: Object.freeze(devices),
  });
}

function validateApiHost(reviewedHost: string, advancedOverride: string | undefined): string {
  if (advancedOverride !== undefined) {
    if (!isHostname(advancedOverride)) {
      throw new ConfigurationError('advancedApiHostOverride must be a hostname without a scheme, port, or path');
    }
    return advancedOverride.toLowerCase();
  }
  if (!REVIEWED_API_HOSTS.includes(reviewedHost as ReviewedApiHost)) {
    throw new ConfigurationError('apiHost must be a reviewed EcoFlow regional endpoint');
  }
  return reviewedHost;
}

function isHostname(value: string): boolean {
  if (value.length > 253 || value.toLowerCase() === 'localhost') {
    return false;
  }
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value.toLowerCase()
      && url.port === ''
      && url.pathname === '/'
      && !url.username
      && !url.password
      && value.includes('.');
  } catch {
    return false;
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
  options: { maxLength?: number } = {},
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigurationError(`${field} must be a non-empty string`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ConfigurationError(`${field} is too long`);
  }
  return field === 'password' ? value : value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ConfigurationError(`${field} must be a string`);
  }
  return value.trim();
}
