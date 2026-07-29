import {
  authenticateEcoFlow,
  type EcoFlowAuthenticatedSession,
} from './auth.js';
import type { EcoFlowWave3Config } from './config.js';
import type { HttpTransport } from './http.js';
import type {
  MqttConnection,
  MqttMessage,
  MqttTransport,
} from './mqtt.js';

const REFRESH_PAYLOAD = JSON.stringify({
  version: '1.1',
  moduleType: 0,
  operateType: 'latestQuotas',
  params: {},
});

export interface Wave3Topics {
  property: string;
  set: string;
  setReply: string;
  get: string;
  getReply: string;
}

export type Wave3InboundMessageKind = 'property' | 'setReply' | 'getReply';

export interface Wave3InboundMessage {
  serialNumber: string;
  kind: Wave3InboundMessageKind;
  payload: Uint8Array;
}

export interface CloudSessionLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const NOOP_LOGGER: CloudSessionLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type CloudSessionState =
  | 'idle'
  | 'starting'
  | 'online'
  | 'offline'
  | 'failed'
  | 'stopped';

export class EcoFlowCloudSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcoFlowCloudSessionError';
  }
}

export class EcoFlowCloudSession {
  private connection?: MqttConnection;
  private authenticated?: EcoFlowAuthenticatedSession;
  private readonly messageListeners = new Set<(message: Wave3InboundMessage) => void>();
  private readonly errorListeners = new Set<(error: EcoFlowCloudSessionError) => void>();
  private detachListeners: Array<() => void> = [];
  private establishPromise?: Promise<void>;
  private stopped = false;

  public state: CloudSessionState = 'idle';

  constructor(
    private readonly config: EcoFlowWave3Config,
    private readonly http: HttpTransport,
    private readonly mqtt: MqttTransport,
    private readonly logger: CloudSessionLogger = NOOP_LOGGER,
    private readonly randomHex?: () => string,
    private readonly operationTimeoutMilliseconds = 15_000,
  ) {}

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new EcoFlowCloudSessionError('EcoFlow cloud session has already been started');
    }
    this.state = 'starting';
    this.logger.info('Authenticating with EcoFlow private cloud');

    let authenticated: EcoFlowAuthenticatedSession;
    try {
      authenticated = await authenticateEcoFlow(
        this.config,
        this.http,
        this.randomHex,
      );
    } catch {
      if (this.stopped) {
        throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
      }
      this.authenticated = undefined;
      this.state = 'failed';
      throw new EcoFlowCloudSessionError('EcoFlow private cloud authentication failed');
    }
    if (this.stopped) {
      throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
    }
    this.authenticated = authenticated;

    let connection: MqttConnection;
    try {
      connection = await this.mqtt.open(authenticated.mqtt);
    } catch {
      if (this.stopped) {
        throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
      }
      this.authenticated = undefined;
      this.state = 'failed';
      throw new EcoFlowCloudSessionError('EcoFlow MQTT connection failed');
    }
    if (this.stopped) {
      await this.closeWithTimeout(connection);
      throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
    }
    this.connection = connection;

    this.attachConnectionListeners(connection);
    const setup = this.establishSubscriptionsAndRefresh();
    this.establishPromise = setup;
    try {
      await setup;
      this.logger.info('EcoFlow MQTT session is ready');
    } catch (error) {
      if (this.stopped) {
        throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
      }
      this.state = 'failed';
      await this.closeConnectionAfterFailure();
      throw error;
    } finally {
      if (this.establishPromise === setup) {
        this.establishPromise = undefined;
      }
    }
  }

  onMessage(listener: (message: Wave3InboundMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: EcoFlowCloudSessionError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async publishCommand(serialNumber: string, payload: Uint8Array): Promise<void> {
    const connection = this.requireOnlineConnection();
    const topics = this.topicsForConfiguredDevice(serialNumber);
    try {
      await withTimeout(
        connection.publish(topics.set, payload),
        this.operationTimeoutMilliseconds,
      );
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow command publication failed');
    }
  }

  async requestState(serialNumber: string): Promise<void> {
    const connection = this.requireOnlineConnection();
    const topics = this.topicsForConfiguredDevice(serialNumber);
    try {
      await withTimeout(
        connection.publish(topics.get, REFRESH_PAYLOAD),
        this.operationTimeoutMilliseconds,
      );
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow state refresh failed');
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.state = 'stopped';
    this.detachConnectionListeners();
    const connection = this.connection;
    this.connection = undefined;
    this.authenticated = undefined;
    if (connection !== undefined) {
      await this.closeWithTimeout(connection);
    }
  }

  private attachConnectionListeners(connection: MqttConnection): void {
    this.detachListeners = [
      connection.onConnect(() => this.scheduleReconnectSetup()),
      connection.onDisconnect(() => {
        if (!this.stopped) {
          this.state = 'offline';
          this.logger.warn('EcoFlow MQTT connection was interrupted');
        }
      }),
      connection.onMessage(message => this.handleMessage(message)),
    ];
  }

  private scheduleReconnectSetup(): void {
    if (this.stopped || this.establishPromise !== undefined) {
      return;
    }
    const setup = this.establishSubscriptionsAndRefresh();
    this.establishPromise = setup
      .catch(async () => {
        if (this.stopped) {
          return;
        }
        const error = new EcoFlowCloudSessionError('EcoFlow MQTT reconnect setup failed');
        this.state = 'failed';
        this.logger.error(error.message);
        this.detachConnectionListeners();
        const connection = this.connection;
        this.connection = undefined;
        this.authenticated = undefined;
        if (connection !== undefined) {
          await this.closeWithTimeout(connection);
        }
        for (const listener of this.errorListeners) {
          listener(error);
        }
      })
      .finally(() => {
        this.establishPromise = undefined;
      });
  }

  private async establishSubscriptionsAndRefresh(): Promise<void> {
    const connection = this.connection;
    const authenticated = this.authenticated;
    if (connection === undefined || authenticated === undefined || this.stopped) {
      throw new EcoFlowCloudSessionError('EcoFlow MQTT session is not available');
    }

    const topicsByDevice = this.config.devices.map(device => ({
      serialNumber: device.serialNumber,
      topics: buildWave3Topics(authenticated.userId, device.serialNumber),
    }));
    const subscriptionTopics = topicsByDevice.flatMap(({ topics }) => [
      topics.property,
      topics.set,
      topics.setReply,
      topics.get,
      topics.getReply,
    ]);

    try {
      await withTimeout(
        connection.subscribe([...new Set(subscriptionTopics)]),
        this.operationTimeoutMilliseconds,
      );
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow MQTT subscription failed');
    }
    this.assertSetupActive(connection);

    try {
      for (const { topics } of topicsByDevice) {
        await withTimeout(
          connection.publish(topics.get, REFRESH_PAYLOAD),
          this.operationTimeoutMilliseconds,
        );
        this.assertSetupActive(connection);
      }
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow state refresh failed');
    }
    this.assertSetupActive(connection);
    this.state = 'online';
  }

  private handleMessage(message: MqttMessage): void {
    const authenticated = this.authenticated;
    if (authenticated === undefined) {
      return;
    }
    for (const device of this.config.devices) {
      const topics = buildWave3Topics(authenticated.userId, device.serialNumber);
      const kind = inboundKindForTopic(message.topic, topics);
      if (kind !== undefined) {
        const inbound = {
          serialNumber: device.serialNumber,
          kind,
          payload: message.payload,
        };
        for (const listener of this.messageListeners) {
          listener(inbound);
        }
        return;
      }
    }
  }

  private requireOnlineConnection(): MqttConnection {
    if (this.connection === undefined || this.state !== 'online' || this.stopped) {
      throw new EcoFlowCloudSessionError('EcoFlow MQTT session is not online');
    }
    return this.connection;
  }

  private topicsForConfiguredDevice(serialNumber: string): Wave3Topics {
    const authenticated = this.authenticated;
    if (authenticated === undefined
      || !this.config.devices.some(device => device.serialNumber === serialNumber)) {
      throw new EcoFlowCloudSessionError('WAVE 3 is not configured for this session');
    }
    return buildWave3Topics(authenticated.userId, serialNumber);
  }

  private detachConnectionListeners(): void {
    for (const detach of this.detachListeners) {
      detach();
    }
    this.detachListeners = [];
  }

  private async closeConnectionAfterFailure(): Promise<void> {
    this.detachConnectionListeners();
    const connection = this.connection;
    this.connection = undefined;
    this.authenticated = undefined;
    if (connection !== undefined) {
      await this.closeWithTimeout(connection);
    }
  }

  private assertSetupActive(connection: MqttConnection): void {
    if (this.stopped || this.connection !== connection) {
      throw new EcoFlowCloudSessionError('EcoFlow MQTT setup was cancelled');
    }
  }

  private async closeWithTimeout(connection: MqttConnection): Promise<void> {
    try {
      await withTimeout(
        connection.close(true),
        this.operationTimeoutMilliseconds,
      );
    } catch {
      this.logger.warn('EcoFlow MQTT connection did not close cleanly');
    }
  }
}

export function buildWave3Topics(userId: string, serialNumber: string): Wave3Topics {
  return {
    property: `/app/device/property/${serialNumber}`,
    set: `/app/${userId}/${serialNumber}/thing/property/set`,
    setReply: `/app/${userId}/${serialNumber}/thing/property/set_reply`,
    get: `/app/${userId}/${serialNumber}/thing/property/get`,
    getReply: `/app/${userId}/${serialNumber}/thing/property/get_reply`,
  };
}

function inboundKindForTopic(
  topic: string,
  topics: Wave3Topics,
): Wave3InboundMessageKind | undefined {
  if (topic === topics.property) {
    return 'property';
  }
  if (topic === topics.setReply) {
    return 'setReply';
  }
  if (topic === topics.getReply) {
    return 'getReply';
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('operation timed out')),
      timeoutMilliseconds,
    );
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
