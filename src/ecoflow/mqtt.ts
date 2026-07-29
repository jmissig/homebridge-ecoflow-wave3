import {
  connectAsync,
  type IClientOptions,
  type ISubscriptionMap,
  type MqttClient,
} from 'mqtt';

import type { EcoFlowMqttCredentials } from './auth.js';

export interface MqttMessage {
  topic: string;
  payload: Uint8Array;
}

export interface MqttConnection {
  onConnect(listener: () => void): () => void;
  onDisconnect(listener: () => void): () => void;
  onMessage(listener: (message: MqttMessage) => void): () => void;
  subscribe(topics: readonly string[]): Promise<void>;
  publish(topic: string, payload: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

export interface MqttTransport {
  open(credentials: EcoFlowMqttCredentials): Promise<MqttConnection>;
}

export class MqttJsTransport implements MqttTransport {
  constructor(
    private readonly optionOverrides: Readonly<Partial<IClientOptions>> = {},
  ) {}

  async open(credentials: EcoFlowMqttCredentials): Promise<MqttConnection> {
    const client = await connectAsync(
      `mqtts://${credentials.host}:${credentials.port}`,
      buildMqttClientOptions(credentials, this.optionOverrides),
    );
    return new MqttJsConnection(client);
  }
}

export function buildMqttClientOptions(
  credentials: EcoFlowMqttCredentials,
  optionOverrides: Readonly<Partial<IClientOptions>> = {},
): IClientOptions {
  return {
    ...optionOverrides,
    clientId: credentials.clientId,
    username: credentials.username,
    password: credentials.password,
    clean: true,
    keepalive: 15,
    rejectUnauthorized: true,
    reconnectPeriod: 1_000,
    connectTimeout: 15_000,
  };
}

class MqttJsConnection implements MqttConnection {
  constructor(private readonly client: MqttClient) {}

  onConnect(listener: () => void): () => void {
    this.client.on('connect', listener);
    return () => this.client.off('connect', listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.client.on('offline', listener);
    return () => this.client.off('offline', listener);
  }

  onMessage(listener: (message: MqttMessage) => void): () => void {
    const mqttListener = (topic: string, payload: Buffer): void => {
      listener({ topic, payload });
    };
    this.client.on('message', mqttListener);
    return () => this.client.off('message', mqttListener);
  }

  async subscribe(topics: readonly string[]): Promise<void> {
    const subscriptions: ISubscriptionMap = Object.fromEntries(
      topics.map(topic => [topic, { qos: 1 }]),
    );
    await this.client.subscribeAsync(subscriptions);
  }

  async publish(topic: string, payload: Uint8Array | string): Promise<void> {
    await this.client.publishAsync(
      topic,
      typeof payload === 'string' ? payload : Buffer.from(payload),
      { qos: 1 },
    );
  }

  async close(): Promise<void> {
    await this.client.endAsync();
  }
}
