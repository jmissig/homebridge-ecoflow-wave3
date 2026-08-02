import { randomInt } from 'node:crypto';

import {
  authenticateEcoFlow,
  EcoFlowAuthenticationError,
  type EcoFlowAuthenticatedSession,
} from './auth.js';
import type { EcoFlowWave3Config } from './config.js';
import type { HttpTransport } from './http.js';
import type {
  MqttConnection,
  MqttMessage,
  MqttTransport,
} from './mqtt.js';
import {
  decodeWave3QuotaReply,
  decodeWave3Message,
  hasWave3ControlStateEvidence,
  hasWave3DisplayEvidence,
} from '../wave3/codec.js';
import type {
  DecodedWave3Message,
  DecodedWave3QuotaReply,
} from '../wave3/codec.js';

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
  generation: number;
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
  private readonly stateListeners = new Set<(state: CloudSessionState) => void>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly publicOperationControllers = new Set<AbortController>();
  private readonly pendingRefreshes = new Map<
    string,
    { requestId: string; generation: number }
  >();
  private readonly lastDisplaySequenceByDevice = new Map<string, number>();
  private detachListeners: Array<() => void> = [];
  private establishPromise?: Promise<void>;
  private lifecycleController?: AbortController;
  private setupGenerationController?: AbortController;
  private startupPromise?: Promise<void>;
  private connectionGeneration = 0;
  private mqttConnected = false;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private connectionFailurePromise?: Promise<void>;

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
    this.setState('starting');
    this.logger.info(
      `EcoFlow diagnostics: starting cloud session (apiHost=${this.config.apiHost}, devices=${this.config.devices.length})`,
    );
    this.logger.info('EcoFlow diagnostics: authenticating with private cloud');

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
    } catch (error) {
      if (this.stopped) {
        throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
      }
      this.authenticated = undefined;
      this.setState('failed');
      this.logger.error(`EcoFlow diagnostics: authentication failed (${safeErrorSummary(error)})`);
      throw new EcoFlowCloudSessionError('EcoFlow private cloud authentication failed');
    }
    if (this.stopped) {
      throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
    }
    this.authenticated = authenticated;
    this.logger.info(
      'EcoFlow diagnostics: authentication and MQTT certification succeeded '
      + `(broker=${authenticated.mqtt.host}:${authenticated.mqtt.port}; `
      + 'account, token, client ID, and credentials redacted)',
    );

    let connection: MqttConnection;
    try {
      this.logger.info('EcoFlow diagnostics: opening TLS MQTT connection');
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
      this.setState('failed');
      this.logger.error('EcoFlow diagnostics: MQTT connection open failed (details redacted)');
      throw new EcoFlowCloudSessionError('EcoFlow MQTT connection failed');
    }
    if (this.stopped) {
      await this.closeWithTimeout(connection);
      throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
    }
    this.connection = connection;
    this.mqttConnected = true;
    this.logger.info('EcoFlow diagnostics: initial MQTT connection opened');

    this.attachConnectionListeners(connection);
    const setup = this.establishLatestConnectionGeneration(controller.signal);
    this.establishPromise = setup;
    try {
      await setup;
      this.logger.info(`EcoFlow MQTT session is ready (generation=${this.connectionGeneration})`);
    } catch (error) {
      if (this.stopped) {
        throw new EcoFlowCloudSessionError('EcoFlow cloud session was stopped during startup');
      }
      this.setState('failed');
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

  onStateChange(listener: (state: CloudSessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async publishCommand(
    serialNumber: string,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const connection = this.requireOnlineConnection();
    const topics = this.topicsForConfiguredDevice(serialNumber);
    this.logger.info(
      `EcoFlow diagnostics: publishing command for ${this.deviceLabel(serialNumber)} (bytes=${payload.length}, generation=${this.connectionGeneration})`,
    );
    try {
      await this.runPublicPublish(
        connection,
        topics.set,
        payload,
        signal,
      );
      this.logger.info(`EcoFlow diagnostics: MQTT broker accepted command publication for ${this.deviceLabel(serialNumber)}`);
    } catch {
      this.logger.error(`EcoFlow diagnostics: command publication failed for ${this.deviceLabel(serialNumber)}`);
      throw new EcoFlowCloudSessionError('EcoFlow command publication failed');
    }
  }

  async requestState(
    serialNumber: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const connection = this.requireOnlineConnection();
    const topics = this.topicsForConfiguredDevice(serialNumber);
    const refresh = this.buildRefreshRequest();
    this.pendingRefreshes.set(serialNumber, {
      requestId: refresh.requestId,
      generation: this.connectionGeneration,
    });
    this.logger.info(
      `EcoFlow diagnostics: publishing explicit latestQuotas refresh for ${this.deviceLabel(serialNumber)} `
      + `(requestId=${refresh.requestId}, generation=${this.connectionGeneration})`,
    );
    try {
      await this.runPublicPublish(
        connection,
        topics.get,
        refresh.payload,
        signal,
      );
      this.logger.info(`EcoFlow diagnostics: MQTT broker accepted explicit refresh publication for ${this.deviceLabel(serialNumber)}`);
    } catch {
      this.clearPendingRefresh(serialNumber, refresh.requestId);
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
    this.logger.info(`EcoFlow diagnostics: stopping cloud session from state=${this.state}`);
    this.stopped = true;
    this.setState('stopped');
    this.lifecycleController?.abort();
    this.setupGenerationController?.abort();
    this.abortPublicOperations();
    this.detachConnectionListeners();
    const connection = this.connection;
    this.connection = undefined;
    this.mqttConnected = false;
    this.authenticated = undefined;
    this.pendingRefreshes.clear();
    this.lastDisplaySequenceByDevice.clear();
    if (connection !== undefined) {
      await this.closeWithTimeout(connection);
    }
    await this.drainOperationsSafely([...this.activeOperations]);
    const establish = this.establishPromise;
    const startup = this.startupPromise;
    const connectionFailure = this.connectionFailurePromise;
    for (const operation of new Set([
      ...(startup === undefined ? [] : [startup]),
      ...(establish === undefined ? [] : [establish]),
      ...(connectionFailure === undefined ? [] : [connectionFailure]),
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
    this.logger.info('EcoFlow diagnostics: cloud session stopped and MQTT resources released');
  }

  private attachConnectionListeners(connection: MqttConnection): void {
    this.detachListeners = [
      connection.onConnect(() => {
        const publicOperationWasActive = this.publicOperationControllers.size > 0;
        this.abortPublicOperations();
        this.mqttConnected = true;
        this.connectionGeneration += 1;
        this.pendingRefreshes.clear();
        this.lastDisplaySequenceByDevice.clear();
        this.logger.info(
          `EcoFlow diagnostics: MQTT connected event received; advancing to generation=${this.connectionGeneration}`,
        );
        this.setState('starting');
        this.setupGenerationController?.abort();
        if (!publicOperationWasActive) {
          this.scheduleReconnectSetup();
        }
      }),
      connection.onDisconnect(() => {
        if (!this.stopped) {
          this.abortPublicOperations();
          this.pendingRefreshes.clear();
          this.lastDisplaySequenceByDevice.clear();
          this.mqttConnected = false;
          this.setState('offline');
          this.logger.warn('EcoFlow MQTT connection was interrupted');
        }
      }),
      connection.onMessage(message => this.handleMessage(message)),
      ...(connection.onReconnect === undefined ? [] : [connection.onReconnect(() => {
        this.logger.info('EcoFlow diagnostics: MQTT.js is attempting a reconnect');
      })]),
      ...(connection.onError === undefined ? [] : [connection.onError(() => {
        this.logger.warn('EcoFlow diagnostics: MQTT client emitted an error (details redacted)');
      })]),
      ...(connection.onClose === undefined ? [] : [connection.onClose(() => {
        this.logger.info('EcoFlow diagnostics: MQTT transport emitted a close event');
      })]),
    ];
    this.logger.info('EcoFlow diagnostics: MQTT connection listeners attached');
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
        this.setState('failed');
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
      this.logger.info(`EcoFlow diagnostics: establishing subscriptions and refresh for generation=${generation}`);
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
      topics.setReply,
      topics.getReply,
    ]);
    this.logger.info(
      `EcoFlow diagnostics: subscribing to ${new Set(subscriptionTopics).size} MQTT topics `
      + `for ${topicsByDevice.length} configured device(s) (topic identifiers redacted)`,
    );

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
    this.logger.info(`EcoFlow diagnostics: MQTT subscriptions acknowledged for generation=${generation}`);

    try {
      for (const { serialNumber, topics } of topicsByDevice) {
        const refresh = this.buildRefreshRequest();
        this.pendingRefreshes.set(serialNumber, {
          requestId: refresh.requestId,
          generation,
        });
        this.logger.info(
          `EcoFlow diagnostics: publishing initial latestQuotas refresh for ${this.deviceLabel(serialNumber)} `
          + `(requestId=${refresh.requestId}, generation=${generation})`,
        );
        try {
          await withSignalAndTimeout(
            this.trackOperation(
              connection.publish(topics.get, refresh.payload, signal),
              generationOperations,
            ),
            signal,
            this.operationTimeoutMilliseconds,
          );
        } catch (error) {
          this.clearPendingRefresh(serialNumber, refresh.requestId);
          throw error;
        }
        this.assertSetupActive(connection, generation);
        this.logger.info(
          `EcoFlow diagnostics: MQTT broker accepted initial refresh publication for ${this.deviceLabel(serialNumber)}`,
        );
      }
    } catch {
      throw new EcoFlowCloudSessionError('EcoFlow state refresh failed');
    }
    this.assertSetupActive(connection, generation);
    this.setState('online');
  }

  private handleMessage(message: MqttMessage): void {
    const authenticated = this.authenticated;
    if (authenticated === undefined || !this.mqttConnected || this.stopped) {
      this.logger.warn(
        'EcoFlow diagnostics: dropping inbound MQTT message because session is inactive '
        + `(bytes=${message.payload.length}, state=${this.state}, connected=${this.mqttConnected})`,
      );
      return;
    }
    this.logger.info(
      `EcoFlow diagnostics: MQTT inbound topic=${sanitizeMqttTopic(message.topic)} `
      + `bytes=${message.payload.length} generation=${this.connectionGeneration}`,
    );
    for (const device of this.config.devices) {
      const topics = buildWave3Topics(authenticated.userId, device.serialNumber);
      const kind = inboundKindForTopic(message.topic, topics);
      if (kind !== undefined) {
        const label = this.deviceLabel(device.serialNumber);
        this.logger.info(`EcoFlow diagnostics: matched inbound message to ${label} as ${kind}`);
        if (kind === 'property') {
          const decoded = decodeWave3Message(message.payload);
          this.logDecodedMessage(label, decoded);
          if (this.propertySupersedesRefresh(device.serialNumber, decoded)) {
            const hadPendingRefresh = this.pendingRefreshes.delete(device.serialNumber);
            this.logger.info(
              `EcoFlow diagnostics: accepted newer display property for ${label}${hadPendingRefresh ? '; pending initial refresh is now superseded' : ''}`,
            );
          }
        } else if (kind === 'getReply') {
          const pending = this.pendingRefreshes.get(device.serialNumber);
          const replyId = parseRefreshReplyId(message.payload);
          if (!this.consumeMatchingRefresh(device.serialNumber, replyId)) {
            this.logger.warn(
              `EcoFlow diagnostics: dropping getReply for ${label}; `
              + `replyId=${replyId ?? '<missing-or-non-string>'}, `
              + `expectedRequestId=${pending?.requestId ?? '<none>'}, `
              + `pendingGeneration=${pending?.generation ?? '<none>'}, `
              + `currentGeneration=${this.connectionGeneration}, `
              + `payloadFormat=${classifyRefreshReplyPayload(message.payload)}`,
            );
            return;
          }
          this.logger.info(`EcoFlow diagnostics: getReply request ID matched pending refresh for ${label}`);
          this.logQuotaReply(label, decodeWave3QuotaReply(message.payload));
        } else {
          this.logDecodedMessage(label, decodeWave3Message(message.payload));
        }
        const inbound = {
          serialNumber: device.serialNumber,
          kind,
          payload: message.payload,
          generation: this.connectionGeneration,
        };
        for (const listener of this.messageListeners) {
          listener(inbound);
        }
        this.logger.info(
          `EcoFlow diagnostics: forwarded ${kind} for ${label} to ${this.messageListeners.size} controller listener(s)`,
        );
        return;
      }
    }
    this.logger.warn(
      `EcoFlow diagnostics: no configured WAVE 3 topic matched inbound message topic=${sanitizeMqttTopic(message.topic)}; message dropped`,
    );
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
    this.logger.info('EcoFlow diagnostics: MQTT connection listeners detached');
  }

  private async closeConnectionAfterFailure(): Promise<void> {
    this.detachConnectionListeners();
    const connection = this.connection;
    this.connection = undefined;
    this.mqttConnected = false;
    this.authenticated = undefined;
    this.pendingRefreshes.clear();
    this.lastDisplaySequenceByDevice.clear();
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

  private async runPublicPublish(
    connection: MqttConnection,
    topic: string,
    payload: Uint8Array | string,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const lifecycleSignal = this.lifecycleController?.signal;
    if (lifecycleSignal === undefined) {
      throw new EcoFlowCloudSessionError('EcoFlow MQTT session is not available');
    }
    const generation = this.connectionGeneration;
    const controller = new AbortController();
    this.publicOperationControllers.add(controller);
    const signal = AbortSignal.any([
      lifecycleSignal,
      controller.signal,
      ...(externalSignal === undefined ? [] : [externalSignal]),
    ]);
    try {
      const operation = this.trackOperation(
        connection.publish(topic, payload, signal),
      );
      await withSignalAndTimeout(
        operation,
        signal,
        this.operationTimeoutMilliseconds,
      );
      if (generation !== this.connectionGeneration
        || !this.mqttConnected
        || this.connection !== connection) {
        throw new EcoFlowCloudSessionError('EcoFlow MQTT generation changed');
      }
    } catch (error) {
      controller.abort();
      await this.failConnectionAfterPublicOperation(connection);
      throw error;
    } finally {
      this.publicOperationControllers.delete(controller);
    }
  }

  private failConnectionAfterPublicOperation(
    expectedConnection: MqttConnection,
  ): Promise<void> {
    if (this.stopped || this.connection !== expectedConnection) {
      return this.connectionFailurePromise ?? Promise.resolve();
    }
    if (this.connectionFailurePromise === undefined) {
      this.connectionFailurePromise = this.performConnectionFailureCleanup(
        expectedConnection,
      );
    }
    return this.connectionFailurePromise;
  }

  private async performConnectionFailureCleanup(
    expectedConnection: MqttConnection,
  ): Promise<void> {
    this.setState('failed');
    this.detachConnectionListeners();
    this.connection = undefined;
    this.mqttConnected = false;
    this.authenticated = undefined;
    this.setupGenerationController?.abort();
    await this.closeWithTimeout(expectedConnection);
    await this.drainOperationsSafely([...this.activeOperations]);
  }

  private abortPublicOperations(): void {
    for (const controller of this.publicOperationControllers) {
      controller.abort();
    }
  }

  private setState(state: CloudSessionState): void {
    if (this.state === state) {
      return;
    }
    const previous = this.state;
    this.state = state;
    this.logger.info(`EcoFlow diagnostics: cloud session state ${previous} -> ${state}`);
    for (const listener of this.stateListeners) {
      listener(state);
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

  private consumeMatchingRefresh(
    serialNumber: string,
    replyId: string | undefined,
  ): boolean {
    const pending = this.pendingRefreshes.get(serialNumber);
    if (pending === undefined
      || pending.generation !== this.connectionGeneration
      || replyId !== pending.requestId) {
      return false;
    }
    this.pendingRefreshes.delete(serialNumber);
    return true;
  }

  private propertySupersedesRefresh(
    serialNumber: string,
    decoded: DecodedWave3Message,
  ): boolean {
    if (decoded.kind !== 'display'
      || !hasWave3ControlStateEvidence(decoded.update)
      || !isNewerSequence(
        decoded.sequence,
        this.lastDisplaySequenceByDevice.get(serialNumber),
      )) {
      return false;
    }
    this.lastDisplaySequenceByDevice.set(serialNumber, decoded.sequence);
    return true;
  }

  private deviceLabel(serialNumber: string): string {
    const index = this.config.devices.findIndex(device => device.serialNumber === serialNumber);
    return index < 0 ? 'unconfigured device' : `device #${index + 1}`;
  }

  private logDecodedMessage(label: string, decoded: DecodedWave3Message): void {
    this.logger.info(`EcoFlow diagnostics: ${label} protobuf decode ${describeDecodedMessage(decoded)}`);
  }

  private logQuotaReply(label: string, decoded: DecodedWave3QuotaReply): void {
    this.logger.info(`EcoFlow diagnostics: ${label} quota decode ${describeQuotaReply(decoded)}`);
  }

  private clearPendingRefresh(serialNumber: string, requestId: string): void {
    if (this.pendingRefreshes.get(serialNumber)?.requestId === requestId) {
      this.pendingRefreshes.delete(serialNumber);
    }
  }

  private buildRefreshRequest(): { requestId: string; payload: string } {
    const requestId = this.refreshRequestId();
    return {
      requestId,
      payload: JSON.stringify({
        from: 'HomeAssistant',
        id: requestId,
        version: '1.1',
        moduleType: 0,
        operateType: 'latestQuotas',
        params: {},
      }),
    };
  }
}

function safeErrorSummary(error: unknown): string {
  return error instanceof EcoFlowAuthenticationError
    ? error.message
    : 'request failed or timed out; details redacted';
}

function sanitizeMqttTopic(topic: string): string {
  const segments = topic.split('/');
  if (segments[0] === ''
    && segments[1] === 'app'
    && segments[2] === 'device'
    && segments[3] === 'property'
    && segments.length === 5) {
    return '/app/device/property/<device>';
  }
  if (segments[0] === ''
    && segments[1] === 'app'
    && segments.length >= 5) {
    return `/app/<account>/<device>/${segments.slice(4).join('/')}`;
  }
  return `<unrecognized-topic segments=${segments.length} chars=${topic.length}>`;
}

function describeDecodedMessage(decoded: DecodedWave3Message): string {
  const diagnostic = JSON.stringify(decoded.diagnostic);
  if (decoded.kind === 'display') {
    return `kind=display sequence=${decoded.sequence} `
      + `evidence=${hasWave3DisplayEvidence(decoded.update)} `
      + `update=${JSON.stringify(decoded.update)} diagnostic=${diagnostic}`;
  }
  if (decoded.kind === 'runtime') {
    return `kind=runtime sequence=${decoded.sequence} temperatures=${JSON.stringify(decoded.temperatures)} diagnostic=${diagnostic}`;
  }
  if (decoded.kind === 'acknowledgement') {
    return `kind=acknowledgement sequence=${decoded.sequence} acknowledgement=${JSON.stringify(decoded.acknowledgement)} diagnostic=${diagnostic}`;
  }
  return `kind=${decoded.kind} diagnostic=${diagnostic}`;
}

function describeQuotaReply(decoded: DecodedWave3QuotaReply): string {
  if (decoded.kind === 'malformed') {
    return `kind=malformed reason=${JSON.stringify(decoded.reason)}`;
  }
  return `kind=quota deviceOnline=${decoded.deviceOnline} `
    + `evidence=${decoded.update === undefined ? false : hasWave3DisplayEvidence(decoded.update)} `
    + `update=${JSON.stringify(decoded.update ?? {})}`;
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

function parseRefreshReplyId(payload: Uint8Array): string | undefined {
  if (payload.length > 64 * 1024) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(payload),
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const message = parsed as Record<string, unknown>;
    return message.operateType === 'latestQuotas' && typeof message.id === 'string'
      ? message.id
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyRefreshReplyPayload(payload: Uint8Array): 'jsonObject' | 'nonJson' {
  for (const byte of payload) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      continue;
    }
    return byte === 0x7b ? 'jsonObject' : 'nonJson';
  }
  return 'nonJson';
}

function isNewerSequence(candidate: number, previous: number | undefined): boolean {
  if (previous === undefined) {
    return true;
  }
  const difference = (candidate - previous) >>> 0;
  return difference !== 0 && difference < 0x8000_0000;
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
