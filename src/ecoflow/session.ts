import { randomInt } from 'node:crypto';

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
  private readonly activeOperations = new Set<Promise<unknown>>();
  private detachListeners: Array<() => void> = [];
  private establishPromise?: Promise<void>;
  private lifecycleController?: AbortController;
  private setupGenerationController?: AbortController;
  private startupPromise?: Promise<void>;
  private connectionGeneration = 0;
  private mqttConnected = false;
  private stopped = false;
  private stopPromise?: Promise<void>;

  public state: CloudSessionState = 'idle';

  constructor(
    private readonly config: EcoFlowWave3Config,
    private readonly http: HttpTransport,
    private readonly mqtt: MqttTransport,
    private readonly logger: CloudSessionLogger = NOOP_LOGGER,
    private readonly randomHex?: () => string,
    private readonly operationTimeoutMilliseconds = 15_000,
    private readonly refreshRequestId: () => string = defaultRefreshRequestId,
  ) {}

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new EcoFlowCloudSessionError('EcoFlow cloud session has already been started');
    }
    this.state = 'starting';
    this.logger.info('Authenticating with EcoFlow private cloud');

    const controller = new AbortController();
    this.lifecycleController = controller;
    const startup = this.startSession(controller);
    this.startupPromise = startup;
    try {
      await startup;
    } finally {
      if (this.startupPromise === startup) {
        this.startupPromise = undefined;
      }
    }
  }

  private async startSession(controller: AbortController): Promise<void> {
    let authenticated: EcoFlowAuthenticatedSession;
    try {
      authenticated = await withAbortAndTimeout(
        authenticateEcoFlow(
          this.config,
          this.http,
          this.randomHex,
          controller.signal,
        ),
        controller,
        this.operationTimeoutMilliseconds,
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
      connection = await withAbortAndTimeout(
        this.mqtt.open(authenticated.mqtt, controller.signal),
        controller,
        this.operationTimeoutMilliseconds,
      );
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
    this.mqttConnected = true;

    this.attachConnectionListeners(connection);
    const setup = this.establishLatestConnectionGeneration(controller.signal);
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
        this.trackOperation(
          connection.publish(topics.set, payload, this.lifecycleController?.signal),
        ),
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
        this.trackOperation(connection.publish(
          topics.get,
          this.buildRefreshPayload(),
          this.lifecycleController?.signal,
        )),
        this.operationTimeoutMilliseconds,
      );
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow state refresh failed');
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise === undefined) {
      this.stopPromise = this.performStop();
    }
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopped = true;
    this.state = 'stopped';
    this.lifecycleController?.abort();
    this.setupGenerationController?.abort();
    this.detachConnectionListeners();
    const connection = this.connection;
    this.connection = undefined;
    this.mqttConnected = false;
    this.authenticated = undefined;
    if (connection !== undefined) {
      await this.closeWithTimeout(connection);
    }
    await this.drainOperationsSafely([...this.activeOperations]);
    const establish = this.establishPromise;
    const startup = this.startupPromise;
    for (const operation of new Set([
      ...(startup === undefined ? [] : [startup]),
      ...(establish === undefined ? [] : [establish]),
    ])) {
      try {
        await withTimeout(
          operation.catch(() => undefined),
          this.operationTimeoutMilliseconds,
        );
      } catch {
        this.logger.warn('EcoFlow cloud setup did not stop cleanly');
      }
    }
    this.lifecycleController = undefined;
    this.setupGenerationController = undefined;
  }

  private attachConnectionListeners(connection: MqttConnection): void {
    this.detachListeners = [
      connection.onConnect(() => {
        this.mqttConnected = true;
        this.connectionGeneration += 1;
        this.setupGenerationController?.abort();
        this.scheduleReconnectSetup();
      }),
      connection.onDisconnect(() => {
        if (!this.stopped) {
          this.mqttConnected = false;
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
    const signal = this.lifecycleController?.signal;
    if (signal === undefined) {
      return;
    }
    const setup = this.establishLatestConnectionGeneration(signal);
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
        this.mqttConnected = false;
        this.authenticated = undefined;
        if (connection !== undefined) {
          await this.closeWithTimeout(connection);
        }
        await this.drainOperationsSafely([...this.activeOperations]);
        for (const listener of this.errorListeners) {
          listener(error);
        }
      })
      .finally(() => {
        this.establishPromise = undefined;
      });
  }

  private async establishLatestConnectionGeneration(
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    while (!this.stopped) {
      const generation = this.connectionGeneration;
      const generationController = new AbortController();
      const generationOperations = new Set<Promise<unknown>>();
      this.setupGenerationController = generationController;
      const signal = AbortSignal.any([
        lifecycleSignal,
        generationController.signal,
      ]);
      try {
        await this.establishSubscriptionsAndRefresh(
          generation,
          signal,
          generationOperations,
        );
        return;
      } catch (error) {
        if (!this.stopped
          && !lifecycleSignal.aborted
          && generation !== this.connectionGeneration) {
          await this.drainOperations([...generationOperations]);
          continue;
        }
        throw error;
      } finally {
        if (this.setupGenerationController === generationController) {
          this.setupGenerationController = undefined;
        }
      }
    }
    throw new EcoFlowCloudSessionError('EcoFlow MQTT setup was cancelled');
  }

  private async establishSubscriptionsAndRefresh(
    generation: number,
    signal: AbortSignal,
    generationOperations: Set<Promise<unknown>>,
  ): Promise<void> {
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
      await withSignalAndTimeout(
        this.trackOperation(
          connection.subscribe([...new Set(subscriptionTopics)], signal),
          generationOperations,
        ),
        signal,
        this.operationTimeoutMilliseconds,
      );
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow MQTT subscription failed');
    }
    this.assertSetupActive(connection, generation);

    try {
      for (const { topics } of topicsByDevice) {
        await withSignalAndTimeout(
          this.trackOperation(
            connection.publish(topics.get, this.buildRefreshPayload(), signal),
            generationOperations,
          ),
          signal,
          this.operationTimeoutMilliseconds,
        );
        this.assertSetupActive(connection, generation);
      }
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow state refresh failed');
    }
    this.assertSetupActive(connection, generation);
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
    if (this.connection === undefined
      || !this.mqttConnected
      || this.state !== 'online'
      || this.stopped) {
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
    this.mqttConnected = false;
    this.authenticated = undefined;
    if (connection !== undefined) {
      await this.closeWithTimeout(connection);
    }
    await this.drainOperationsSafely([...this.activeOperations]);
  }

  private assertSetupActive(connection: MqttConnection, generation: number): void {
    if (this.stopped
      || this.connection !== connection
      || !this.mqttConnected
      || generation !== this.connectionGeneration) {
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

  private trackOperation<T>(
    operation: Promise<T>,
    generationOperations?: Set<Promise<unknown>>,
  ): Promise<T> {
    this.activeOperations.add(operation);
    generationOperations?.add(operation);
    void operation.then(
      () => {
        this.activeOperations.delete(operation);
        generationOperations?.delete(operation);
      },
      () => {
        this.activeOperations.delete(operation);
        generationOperations?.delete(operation);
      },
    );
    return operation;
  }

  private async drainOperations(operations: readonly Promise<unknown>[]): Promise<void> {
    if (operations.length === 0) {
      return;
    }
    await withTimeout(
      Promise.allSettled(operations).then(() => undefined),
      this.operationTimeoutMilliseconds,
    );
  }

  private async drainOperationsSafely(
    operations: readonly Promise<unknown>[],
  ): Promise<void> {
    try {
      await this.drainOperations(operations);
    } catch {
      this.logger.warn('EcoFlow MQTT operation did not settle cleanly');
    }
  }

  private buildRefreshPayload(): string {
    return JSON.stringify({
      from: 'HomeAssistant',
      id: this.refreshRequestId(),
      version: '1.1',
      moduleType: 0,
      operateType: 'latestQuotas',
      params: {},
    });
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

async function withAbortAndTimeout<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMilliseconds: number,
): Promise<T> {
  const timeoutMarker = Symbol('timeout');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof timeoutMarker>(resolve => {
    timer = setTimeout(() => resolve(timeoutMarker), timeoutMilliseconds);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([promise, timeout]);
    if (outcome !== timeoutMarker) {
      return outcome;
    }
    controller.abort();
    try {
      await withTimeout(promise, timeoutMilliseconds);
    } catch {
      // The original operation owns cleanup after cancellation. Shutdown is
      // still bounded if an external adapter violates that contract.
    }
    throw new Error('operation timed out');
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function defaultRefreshRequestId(): string {
  return String(randomInt(999_910_000, 1_000_000_000));
}

async function withSignalAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<T> {
  const aborted = rejectWhenAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('operation timed out')),
      timeoutMilliseconds,
    );
    timer.unref();
  });
  try {
    return await Promise.race([
      promise,
      timeout,
      aborted.promise,
    ]);
  } finally {
    aborted.detach();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function rejectWhenAborted(signal: AbortSignal): {
  promise: Promise<never>;
  detach: () => void;
} {
  let handleAbort = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(new Error('operation cancelled'));
    if (signal.aborted) {
      handleAbort();
      return;
    }
    signal.addEventListener('abort', handleAbort, { once: true });
  });
  return {
    promise,
    detach: () => signal.removeEventListener('abort', handleAbort),
  };
}
