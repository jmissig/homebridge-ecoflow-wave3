import {
  connect,
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
  onReconnect?(listener: () => void): () => void;
  onError?(listener: () => void): () => void;
  onClose?(listener: () => void): () => void;
  onMessage(listener: (message: MqttMessage) => void): () => void;
  subscribe(topics: readonly string[], signal?: AbortSignal): Promise<void>;
  publish(
    topic: string,
    payload: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export interface MqttTransport {
  open(
    credentials: EcoFlowMqttCredentials,
    signal?: AbortSignal,
  ): Promise<MqttConnection>;
}

const NOOP_MQTT_LOG = (): void => undefined;
const RECONNECT_PERIOD_MILLISECONDS = 1_000;

export class MqttJsTransport implements MqttTransport {
  async open(
    credentials: EcoFlowMqttCredentials,
    signal?: AbortSignal,
  ): Promise<MqttConnection> {
    if (signal?.aborted === true) {
      throw new Error('MQTT connection was cancelled');
    }

    const client = connect(
      `mqtts://${credentials.host}:${credentials.port}`,
      buildMqttClientOptions(credentials),
    );

    return new Promise<MqttConnection>((resolve, reject) => {
      let settled = false;
      function cleanup(): void {
        client.off('connect', handleConnect);
        client.off('error', handleError);
        client.off('close', handleClose);
        signal?.removeEventListener('abort', handleAbort);
      }
      function fail(error: Error): void {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        void client.endAsync(true).then(
          () => reject(error),
          () => reject(error),
        );
      }
      function handleConnect(): void {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        // The first connection is deliberately non-retrying so start() can
        // own its deadline. Once connected, MQTT.js may manage reconnects.
        client.options.reconnectPeriod = RECONNECT_PERIOD_MILLISECONDS;
        resolve(new MqttJsConnection(client));
      }
      function handleError(): void {
        fail(new Error('MQTT connection failed'));
      }
      function handleClose(): void {
        fail(new Error('MQTT connection closed'));
      }
      function handleAbort(): void {
        fail(new Error('MQTT connection was cancelled'));
      }

      client.once('connect', handleConnect);
      client.once('error', handleError);
      client.once('close', handleClose);
      signal?.addEventListener('abort', handleAbort, { once: true });
    });
  }
}

export function buildMqttClientOptions(
  credentials: EcoFlowMqttCredentials,
): IClientOptions {
  return {
    clientId: credentials.clientId,
    username: credentials.username,
    password: credentials.password,
    clean: true,
    keepalive: 15,
    rejectUnauthorized: true,
    resubscribe: false,
    reconnectPeriod: 0,
    connectTimeout: 15_000,
    log: NOOP_MQTT_LOG,
  };
}

class MqttJsConnection implements MqttConnection {
  private readonly pendingOperations = new Set<Promise<unknown>>();

  constructor(private readonly client: MqttClient) {}

  onConnect(listener: () => void): () => void {
    this.client.on('connect', listener);
    return () => this.client.off('connect', listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.client.on('offline', listener);
    return () => this.client.off('offline', listener);
  }

  onReconnect(listener: () => void): () => void {
    this.client.on('reconnect', listener);
    return () => this.client.off('reconnect', listener);
  }

  onError(listener: () => void): () => void {
    this.client.on('error', listener);
    return () => this.client.off('error', listener);
  }

  onClose(listener: () => void): () => void {
    this.client.on('close', listener);
    return () => this.client.off('close', listener);
  }

  onMessage(listener: (message: MqttMessage) => void): () => void {
    const mqttListener = (topic: string, payload: Buffer): void => {
      listener({ topic, payload });
    };
    this.client.on('message', mqttListener);
    return () => this.client.off('message', mqttListener);
  }

  async subscribe(topics: readonly string[], signal?: AbortSignal): Promise<void> {
    assertSignalActive(signal);
    const subscriptions: ISubscriptionMap = Object.fromEntries(
      topics.map(topic => [topic, { qos: 1 }]),
    );
    await this.runOperation(this.client.subscribeAsync(subscriptions));
  }

  async publish(
    topic: string,
    payload: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertSignalActive(signal);
    await this.runOperation(
      this.client.publishAsync(
        topic,
        typeof payload === 'string' ? payload : Buffer.from(payload),
        { qos: 1 },
      ),
    );
  }

  async close(force = false): Promise<void> {
    await this.client.endAsync(force);
    await Promise.allSettled([...this.pendingOperations]);
  }

  private async runOperation<T>(
    operation: Promise<T>,
  ): Promise<T> {
    this.pendingOperations.add(operation);
    void operation.then(
      () => this.pendingOperations.delete(operation),
      () => this.pendingOperations.delete(operation),
    );
    return operation;
  }
}

function assertSignalActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error('MQTT operation was cancelled');
  }
}
