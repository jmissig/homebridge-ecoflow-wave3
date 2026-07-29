import { randomBytes } from 'node:crypto';

import type { EcoFlowWave3Config } from './config.js';
import type { HttpResponse, HttpTransport } from './http.js';

export interface EcoFlowMqttCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  clientId: string;
}

export interface EcoFlowAuthenticatedSession {
  userId: string;
  token: string;
  mqtt: EcoFlowMqttCredentials;
}

export class EcoFlowAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcoFlowAuthenticationError';
  }
}

export async function authenticateEcoFlow(
  config: EcoFlowWave3Config,
  http: HttpTransport,
  randomHex: () => string = defaultRandomHex,
  signal?: AbortSignal,
): Promise<EcoFlowAuthenticatedSession> {
  const baseUrl = `https://${config.apiHost}`;
  const loginResponse = await guardedRequest(
    http,
    {
      method: 'POST',
      url: new URL('/auth/login', baseUrl),
      headers: {
        lang: 'en_US',
        'content-type': 'application/json',
      },
      body: {
        type: 'json',
        value: {
          email: config.email,
          password: Buffer.from(config.password, 'utf8').toString('base64'),
          scene: 'IOT_APP',
          userType: 'ECOFLOW',
        },
      },
    },
    'login',
    signal,
  );
  const loginData = requireSuccessfulData(loginResponse, 'login');
  const token = requireNestedString(loginData, ['token'], 'login token');
  const userId = requireNestedString(loginData, ['user', 'userId'], 'login user ID');

  const certificationResponse = await guardedRequest(
    http,
    {
      method: 'GET',
      url: new URL('/iot-auth/app/certification', baseUrl),
      headers: {
        lang: 'en_US',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: {
        type: 'form',
        fields: { userId },
      },
    },
    'MQTT certification',
    signal,
  );
  const certificationData = requireSuccessfulData(certificationResponse, 'MQTT certification');
  const host = normalizeBrokerHost(requireNestedString(certificationData, ['url'], 'MQTT broker host'));
  const port = requirePort(certificationData);
  const username = requireNestedString(
    certificationData,
    ['certificateAccount'],
    'MQTT account',
  );
  const password = requireNestedString(
    certificationData,
    ['certificatePassword'],
    'MQTT password',
  );

  return {
    userId,
    token,
    mqtt: {
      host,
      port,
      username,
      password,
      clientId: `ANDROID_${randomHex().toUpperCase()}_${userId}`,
    },
  };
}

async function guardedRequest(
  http: HttpTransport,
  request: Parameters<HttpTransport['request']>[0],
  operation: string,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  try {
    const response = await http.request(request, signal);
    if (response.status !== 200) {
      throw new EcoFlowAuthenticationError(
        `EcoFlow ${operation} failed with HTTP status ${response.status}`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof EcoFlowAuthenticationError) {
      throw error;
    }
    throw new EcoFlowAuthenticationError(`EcoFlow ${operation} request failed`);
  }
}

function requireSuccessfulData(response: HttpResponse, operation: string): Record<string, unknown> {
  const root = requireRecord(response.json, `${operation} response`);
  if (typeof root.message !== 'string' || root.message.toLowerCase() !== 'success') {
    throw new EcoFlowAuthenticationError(`EcoFlow ${operation} was not successful`);
  }
  return requireRecord(root.data, `${operation} response data`);
}

function requireNestedString(
  root: Record<string, unknown>,
  path: readonly string[],
  label: string,
): string {
  let value: unknown = root;
  for (const component of path) {
    value = requireRecord(value, label)[component];
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new EcoFlowAuthenticationError(`EcoFlow response omitted ${label}`);
  }
  return value;
}

function requirePort(data: Record<string, unknown>): number {
  const rawPort = data.port;
  const port = typeof rawPort === 'string' ? Number(rawPort) : rawPort;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new EcoFlowAuthenticationError('EcoFlow response contained an invalid MQTT port');
  }
  return port as number;
}

function normalizeBrokerHost(value: string): string {
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`mqtts://${value}`);
    if (url.hostname.length === 0 || (url.protocol !== 'mqtts:' && url.protocol !== 'ssl:')) {
      throw new Error('unsupported MQTT URL');
    }
    if ((url.pathname !== '' && url.pathname !== '/')
      || url.search !== ''
      || url.hash !== ''
      || url.username
      || url.password) {
      throw new Error('unexpected MQTT URL components');
    }
    return url.hostname;
  } catch {
    throw new EcoFlowAuthenticationError('EcoFlow response contained an invalid MQTT broker host');
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EcoFlowAuthenticationError(`EcoFlow response omitted ${label}`);
  }
  return value as Record<string, unknown>;
}

function defaultRandomHex(): string {
  return randomBytes(16).toString('hex');
}
