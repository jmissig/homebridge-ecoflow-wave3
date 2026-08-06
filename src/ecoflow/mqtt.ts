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

export class MqttJsConnection implements MqttConnection {
  private closePromise?: Promise<void>;
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
    this.assertOpen();
    assertSignalActive(signal);
    const subscriptions: ISubscriptionMap = Object.fromEntries(
      topics.map(topic => [topic, { qos: 1 }]),
    );
    await this.runOperation(this.client.subscribeAsync(subscriptions), signal);
  }

  async publish(
    topic: string,
    payload: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertOpen();
    assertSignalActive(signal);
    await this.runOperation(
      this.client.publishAsync(
        topic,
        typeof payload === 'string' ? payload : Buffer.from(payload),
        { qos: 1 },
      ),
      signal,
    );
  }

  async close(force = false): Promise<void> {
    await this.beginClose(force);
    await Promise.allSettled([...this.pendingOperations]);
  }

  private async runOperation<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let detachAbort = (): void => undefined;
    const cancellable = new Promise<T>((resolve, reject) => {
      let cancelled = false;
      const handleAbort = (): void => {
        cancelled = true;
        void this.beginClose(true).then(
          () => reject(new Error('MQTT operation was cancelled')),
          () => reject(new Error('MQTT operation was cancelled')),
        );
      };
      signal?.addEventListener('abort', handleAbort, { once: true });
      detachAbort = () => signal?.removeEventListener('abort', handleAbort);
      void operation.then(
        value => {
          if (!cancelled) {
            resolve(value);
          }
        },
        error => {
          if (!cancelled) {
            reject(error);
          }
        },
      );
    });
    this.pendingOperations.add(cancellable);
    void cancellable.then(
      () => this.pendingOperations.delete(cancellable),
      () => this.pendingOperations.delete(cancellable),
    ).finally(detachAbort);
    return cancellable;
  }

  private beginClose(force: boolean): Promise<void> {
    // MQTT.js cannot escalate end(false) after it marks itself disconnecting.
    // If an operation is still pending, start with a forced close so a later
    // cancellation cannot become trapped behind graceful QoS settlement.
    const effectiveForce = force || this.pendingOperations.size > 0;
    this.closePromise ??= this.client.endAsync(effectiveForce);
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closePromise !== undefined) {
      throw new Error('MQTT connection is closing');
    }
  }
}

function assertSignalActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error('MQTT operation was cancelled');
  }
}
