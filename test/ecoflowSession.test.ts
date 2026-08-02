import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { create, toBinary } from '@bufbuild/protobuf';

import type { EcoFlowMqttCredentials } from '../src/ecoflow/auth.js';
import { parseEcoFlowWave3Config } from '../src/ecoflow/config.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../src/ecoflow/http.js';
import {
  buildMqttClientOptions,
  type MqttConnection,
  type MqttMessage,
  type MqttTransport,
} from '../src/ecoflow/mqtt.js';
import {
  buildWave3Topics,
  EcoFlowCloudSession,
  EcoFlowCloudSessionError,
  type CloudSessionLogger,
  type Wave3InboundMessage,
} from '../src/ecoflow/session.js';
import {
  Wave3DisplayPropertyUploadSchema,
  Wave3RuntimePropertyUploadSchema,
  Wave3SetMessageSchema,
} from '../src/proto/gen/ecoflow/wave3/v1/wave3_pb.js';
import { Wave3Controller } from '../src/wave3/controller.js';

const EXPECTED_REFRESH_PAYLOAD = JSON.stringify({
  from: 'HomeAssistant',
  id: '999910001',
  version: '1.1',
  moduleType: 0,
  operateType: 'latestQuotas',
  params: {},
});

describe('EcoFlow cloud session', () => {
  it('authenticates, subscribes, refreshes, routes messages, publishes, and stops', async () => {
    const http = successfulHttp();
    const connection = new FakeMqttConnection();
    const mqtt = new FakeMqttTransport(connection);
    const requestIds = sequentialRequestIds();
    const session = new EcoFlowCloudSession(
      testConfig(),
      http,
      mqtt,
      undefined,
      undefined,
      15_000,
      requestIds,
    );
    const messages: Wave3InboundMessage[] = [];
    const states: string[] = [];
    session.onMessage(message => messages.push(message));
    session.onStateChange(state => states.push(state));

    await session.start();

    assert.equal(session.state, 'online');
    assert.deepEqual(states, ['starting', 'online']);
    assert.equal(mqtt.credentials?.host, 'mqtt.example.test');
    assert.equal(connection.subscribeCalls.length, 1);
    assert.deepEqual(
      connection.subscribeCalls[0],
      [
        buildWave3Topics('TEST_USER', 'TESTWAVE30001').property,
        buildWave3Topics('TEST_USER', 'TESTWAVE30001').setReply,
        buildWave3Topics('TEST_USER', 'TESTWAVE30001').getReply,
        buildWave3Topics('TEST_USER', 'TESTWAVE30002').property,
        buildWave3Topics('TEST_USER', 'TESTWAVE30002').setReply,
        buildWave3Topics('TEST_USER', 'TESTWAVE30002').getReply,
      ],
    );
    assert.equal(connection.publishCalls.length, 2);
    assert.equal(connection.publishCalls[0]?.topic.endsWith('/thing/property/get'), true);
    assert.equal(connection.publishCalls[0]?.payload, EXPECTED_REFRESH_PAYLOAD);
    assert.equal(
      connection.publishCalls[1]?.payload,
      EXPECTED_REFRESH_PAYLOAD.replace('999910001', '999910002'),
    );

    const propertyTopic = buildWave3Topics('TEST_USER', 'TESTWAVE30002').property;
    connection.emitMessage({ topic: propertyTopic, payload: Uint8Array.of(1, 2) });
    assert.deepEqual(messages, [{
      serialNumber: 'TESTWAVE30002',
      kind: 'property',
      payload: Uint8Array.of(1, 2),
      generation: 0,
    }]);

    await session.publishCommand('TESTWAVE30001', Uint8Array.of(3, 4));
    assert.deepEqual(connection.publishCalls.at(-1), {
      topic: buildWave3Topics('TEST_USER', 'TESTWAVE30001').set,
      payload: Uint8Array.of(3, 4),
    });
    await assert.rejects(
      session.publishCommand('UNCONFIGURED', Uint8Array.of()),
      /not configured/,
    );
    await session.requestState('TESTWAVE30001');
    assert.equal(
      connection.publishCalls.at(-1)?.payload,
      EXPECTED_REFRESH_PAYLOAD.replace('999910001', '999910003'),
    );

    await session.stop();
    await session.stop();
    assert.equal(session.state, 'stopped');
    assert.deepEqual(states, ['starting', 'online', 'stopped']);
    assert.equal(connection.closeCalls, 1);
    assert.deepEqual(connection.closeForces, [true]);
    assert.equal(connection.totalListenerCount(), 0);
  });

  it('keeps a controller stale until a routed quota reply proves current device state', async () => {
    const connection = new FakeMqttConnection();
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
      undefined,
      undefined,
      15_000,
      sequentialRequestIds(),
    );
    const controller = new Wave3Controller('TESTWAVE30001', session);

    await session.start();
    assert.equal(session.state, 'online');
    assert.equal(controller.snapshot.availability, 'stale');

    connection.emitMessage({
      topic: buildWave3Topics('TEST_USER', 'TESTWAVE30001').property,
      payload: humidityPacket(9, 73.2),
    });
    assert.equal(controller.snapshot.availability, 'stale');

    const getReply = buildWave3Topics('TEST_USER', 'TESTWAVE30001').getReply;
    connection.emitMessage({
      topic: getReply,
      payload: jsonBytes({
        id: '999999999',
        operateType: 'latestQuotas',
        data: { online: 0 },
      }),
    });
    assert.equal(controller.snapshot.availability, 'stale');
    connection.emitMessage({
      topic: getReply,
      payload: jsonBytes({
        id: '999910001',
        operateType: 'latestQuotas',
        data: {
          online: 1,
          quotaMap: {
            dev_sleep_state: 0,
            wave_operating_mode: 1,
            temp_ambient: 24,
            current_temp_set: 22,
          },
        },
      }),
    });
    assert.equal(controller.snapshot.availability, 'online');
    assert.equal(controller.snapshot.state.targetTemperatureCelsius, 22);

    connection.emitDisconnect();
    assert.equal(controller.snapshot.availability, 'reconnecting');
    const propertyTopic = buildWave3Topics('TEST_USER', 'TESTWAVE30001').property;
    connection.emitMessage({
      topic: propertyTopic,
      payload: displayPacket(10, 2, 26, 23),
    });
    assert.equal(controller.snapshot.availability, 'reconnecting');
    assert.deepEqual(controller.snapshot.state, {});

    connection.emitConnect();
    await flushAsyncWork();
    assert.equal(session.state, 'online');
    assert.equal(controller.snapshot.availability, 'stale');

    connection.emitMessage({
      topic: propertyTopic,
      payload: runtimePacket(11, 42),
    });
    assert.equal(controller.snapshot.availability, 'stale');
    connection.emitMessage({
      topic: getReply,
      payload: jsonBytes({
        id: '999910003',
        operateType: 'latestQuotas',
        data: {
          online: 1,
          quotaMap: {
            dev_sleep_state: 0,
            wave_operating_mode: 1,
            current_temp_set: 22,
          },
        },
      }),
    });
    assert.equal(controller.snapshot.availability, 'online');

    await session.requestState('TESTWAVE30001');
    connection.emitMessage({
      topic: propertyTopic,
      payload: displayPacket(12, 2, 25, 23),
    });
    connection.emitMessage({
      topic: getReply,
      payload: jsonBytes({
        id: '999910005',
        operateType: 'latestQuotas',
        data: { online: 0 },
      }),
    });
    assert.equal(controller.snapshot.availability, 'online');
    assert.equal(controller.snapshot.state.mode, 'heat');

    await session.requestState('TESTWAVE30001');
    connection.emitMessage({
      topic: propertyTopic,
      payload: Uint8Array.of(0xff),
    });
    connection.emitMessage({
      topic: propertyTopic,
      payload: displayPacket(11, 1, 24, 22),
    });
    connection.emitMessage({
      topic: getReply,
      payload: jsonBytes({
        id: '999910006',
        operateType: 'latestQuotas',
        data: { online: 0 },
      }),
    });
    assert.equal(controller.snapshot.availability, 'offline');

    controller.stop();
    await session.stop();
  });

  it('re-subscribes and refreshes once for every clean-session connection generation', async () => {
    const connection = new FakeMqttConnection();
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
    );
    await session.start();
    assert.equal(connection.totalListenerCount(), 3);

    connection.emitDisconnect();
    assert.equal(session.state, 'offline');
    connection.emitConnect();
    connection.emitConnect();
    await flushAsyncWork();

    assert.equal(session.state, 'online');
    assert.equal(connection.subscribeCalls.length, 3);
    // The intermediate generation is superseded before refresh; only the
    // initial and latest clean sessions complete the full refresh cycle.
    assert.equal(connection.publishCalls.length, 4);
    assert.equal(connection.totalListenerCount(), 3);
    await session.stop();
  });

  it('restarts setup for a new clean-session generation during an in-flight refresh', async () => {
    const refreshGate = new Deferred<void>();
    const connection = new FakeMqttConnection();
    connection.publishGate = refreshGate;
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
    );
    const start = session.start();
    await flushAsyncWork();
    assert.equal(connection.subscribeCalls.length, 1);

    connection.emitDisconnect();
    connection.emitConnect();
    await flushAsyncWork();

    assert.equal(connection.subscribeCalls.length, 2);
    assert.notEqual(session.state, 'online');
    refreshGate.resolve();
    await start;
    assert.equal(session.state, 'online');
    assert.equal(connection.subscribeCalls.length, 2);
    await session.stop();
  });

  it('drains an uncooperative superseded operation before restart and shutdown', async () => {
    const refreshGate = new Deferred<void>();
    const connection = new FakeMqttConnection();
    connection.publishGate = refreshGate;
    connection.ignoreOperationAbort = true;
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
      new CapturingLogger(),
      undefined,
      1_000,
    );
    const start = session.start();
    await flushAsyncWork();

    connection.emitDisconnect();
    connection.emitConnect();
    await flushAsyncWork();
    assert.equal(connection.subscribeCalls.length, 1);
    assert.notEqual(session.state, 'online');

    let stopSettled = false;
    const stopping = session.stop().then(() => {
      stopSettled = true;
    });
    await flushAsyncWork();
    assert.equal(stopSettled, false);

    refreshGate.resolve();
    await stopping;
    await assert.rejects(start, /stopped during startup/);
    assert.equal(stopSettled, true);
    assert.equal(session.state, 'stopped');
  });

  it('fails the connection before a late command or manual refresh can cross generations', async () => {
    const operations = [
      async (session: EcoFlowCloudSession) => {
        await session.publishCommand('TESTWAVE30001', Uint8Array.of(7));
      },
      async (session: EcoFlowCloudSession) => {
        await session.requestState('TESTWAVE30001');
      },
    ];

    for (const operation of operations) {
      const connection = new FakeMqttConnection();
      const session = new EcoFlowCloudSession(
        testConfig(),
        successfulHttp(),
        new FakeMqttTransport(connection),
        new CapturingLogger(),
        undefined,
        10,
      );
      await session.start();
      const initialSubscriptions = connection.subscribeCalls.length;
      const latePublishGate = new Deferred<void>();
      connection.publishGate = latePublishGate;
      connection.ignoreOperationAbort = true;

      await assert.rejects(operation(session), /failed/);
      assert.equal(session.state, 'failed');
      assert.equal(connection.closeCalls, 1);
      assert.equal(connection.totalListenerCount(), 0);

      connection.emitDisconnect();
      connection.emitConnect();
      await flushAsyncWork();
      assert.equal(connection.subscribeCalls.length, initialSubscriptions);
      assert.equal(session.state, 'failed');

      latePublishGate.resolve();
      await flushAsyncWork();
      assert.equal(session.state, 'failed');
      await session.stop();
    }
  });

  it('cancels a controller-owned publication and fails its connection generation', async () => {
    const connection = new FakeMqttConnection();
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
    );
    await session.start();
    connection.publishGate = new Deferred<void>();
    const controller = new AbortController();
    const publishing = session.publishCommand(
      'TESTWAVE30001',
      Uint8Array.of(9),
      controller.signal,
    );
    await flushAsyncWork();
    controller.abort();

    await assert.rejects(publishing, /publication failed/);
    assert.equal(session.state, 'failed');
    assert.equal(connection.closeCalls, 1);
    assert.equal(connection.totalListenerCount(), 0);
    await session.stop();
  });

  it('joins public-publish failure cleanup when stop is called concurrently', async () => {
    const connection = new FakeMqttConnection();
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
      new CapturingLogger(),
      undefined,
      1_000,
    );
    await session.start();
    connection.failPublish = true;
    const closeGate = new Deferred<void>();
    connection.closeGate = closeGate;

    let publishSettled = false;
    const publishing = session.publishCommand(
      'TESTWAVE30001',
      Uint8Array.of(8),
    ).finally(() => {
      publishSettled = true;
    });
    await flushAsyncWork();
    assert.equal(connection.closeCalls, 1);

    let stopSettled = false;
    const stopping = session.stop().then(() => {
      stopSettled = true;
    });
    await flushAsyncWork();
    assert.equal(stopSettled, false);
    assert.equal(publishSettled, false);

    closeGate.resolve();
    await assert.rejects(publishing, /publication failed/);
    await stopping;
    assert.equal(stopSettled, true);
    assert.equal(session.state, 'stopped');
  });

  it('surfaces bounded subscription and refresh failures and closes the connection', async () => {
    const subscriptionFailure = new FakeMqttConnection();
    subscriptionFailure.failSubscribe = true;
    const firstSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(subscriptionFailure),
    );
    await assert.rejects(firstSession.start(), /subscription failed/);
    assert.equal(firstSession.state, 'failed');
    assert.equal(subscriptionFailure.closeCalls, 1);

    const refreshFailure = new FakeMqttConnection();
    refreshFailure.failPublish = true;
    const secondSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(refreshFailure),
    );
    await assert.rejects(secondSession.start(), /state refresh failed/);
    assert.equal(secondSession.state, 'failed');
    assert.equal(refreshFailure.closeCalls, 1);
  });

  it('reports reconnect setup failures through a bounded error channel', async () => {
    const connection = new FakeMqttConnection();
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
    );
    const errors: EcoFlowCloudSessionError[] = [];
    session.onError(error => errors.push(error));
    await session.start();

    connection.emitDisconnect();
    connection.failSubscribe = true;
    connection.emitConnect();
    await flushAsyncWork();

    assert.equal(session.state, 'failed');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, 'EcoFlow MQTT reconnect setup failed');
    assert.equal(connection.closeCalls, 1);
    assert.equal(connection.totalListenerCount(), 0);
    await session.stop();
  });

  it('redacts secrets from session errors and logs', async () => {
    const logger = new CapturingLogger();
    const secretErrorTransport: MqttTransport = {
      open: async credentials => {
        throw new Error([
          credentials.username,
          credentials.password,
          credentials.clientId,
          'TESTWAVE30001',
          'owner@example.test',
        ].join(' '));
      },
    };
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      secretErrorTransport,
      logger,
      () => 'SECRET_RANDOM',
    );

    await assert.rejects(
      session.start(),
      (error: unknown) => {
        assert.equal((error as Error).message, 'EcoFlow MQTT connection failed');
        return true;
      },
    );

    const visibleText = logger.messages.join(' ');
    for (const secret of [
      'owner@example.test',
      'TEST_ACCOUNT_PASSWORD',
      'TEST_TOKEN',
      'TEST_MQTT_ACCOUNT',
      'TEST_MQTT_PASSWORD',
      'TESTWAVE30001',
      'SECRET_RANDOM',
    ]) {
      assert.equal(visibleText.includes(secret), false);
    }
  });

  it('logs inbound routing and decode decisions without exposing MQTT identifiers or raw payloads', async () => {
    const logger = new CapturingLogger();
    const connection = new FakeMqttConnection();
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
      logger,
      undefined,
      15_000,
      sequentialRequestIds(),
    );

    await session.start();
    connection.emitMessage({
      topic: '/app/device/property/TESTWAVE30001',
      payload: Uint8Array.of(0xff),
    });
    connection.emitMessage({
      topic: '/app/TEST_USER/TESTWAVE30001/thing/property/get_reply',
      payload: jsonBytes({
        id: 'UNEXPECTED_REPLY_ID',
        operateType: 'latestQuotas',
        data: {
          online: 1,
          quotaMap: {
            dev_sleep_state: 0,
            wave_operating_mode: 1,
          },
        },
      }),
    });
    connection.emitMessage({
      topic: '/app/TEST_USER/TESTWAVE30001/thing/property/get_reply',
      payload: Uint8Array.of(0xff, 0x00, 0x80),
    });
    connection.emitMessage({
      topic: '/app/UNEXPECTED_ACCOUNT/UNEXPECTED_DEVICE/thing/property/unknown',
      payload: Uint8Array.of(1, 2, 3),
    });
    await session.stop();

    const visibleText = logger.messages.join('\n');
    for (const expected of [
      'topic=/app/device/property/<device>',
      'protobuf decode kind=malformed',
      'dropping getReply for device #1',
      'payloadFormat=jsonObject',
      'payloadFormat=nonJson',
      'no configured WAVE 3 topic matched',
      'controller listener(s)',
    ]) {
      assert.equal(visibleText.includes(expected), true, expected);
    }
    for (const secret of [
      'TEST_USER',
      'TESTWAVE30001',
      'TESTWAVE30002',
      'UNEXPECTED_ACCOUNT',
      'UNEXPECTED_DEVICE',
      'owner@example.test',
      'TEST_ACCOUNT_PASSWORD',
      'TEST_TOKEN',
      'TEST_MQTT_ACCOUNT',
      'TEST_MQTT_PASSWORD',
    ]) {
      assert.equal(visibleText.includes(secret), false, secret);
    }
  });

  it('cancels never-resolving authentication and MQTT open operations', async () => {
    const http: HttpTransport = {
      request: async (_request, signal) => neverUntilAborted(signal),
    };
    const authenticationSession = new EcoFlowCloudSession(
      testConfig(),
      http,
      new FakeMqttTransport(new FakeMqttConnection()),
      new CapturingLogger(),
      undefined,
      1_000,
    );
    const stoppedAuthenticationStart = authenticationSession.start();
    await flushAsyncWork();
    await completesWithin(authenticationSession.stop(), 100);
    await assert.rejects(stoppedAuthenticationStart, /stopped during startup/);

    const openSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      { open: async (_credentials, signal) => neverUntilAborted(signal) },
      new CapturingLogger(),
      undefined,
      1_000,
    );
    const openStart = openSession.start();
    await flushAsyncWork();
    await completesWithin(openSession.stop(), 100);
    await assert.rejects(openStart, /stopped during startup/);
  });

  it('stops promptly during initial subscription, refresh, and reconnect setup', async () => {
    const subscribeGate = new Deferred<void>();
    const subscribingConnection = new FakeMqttConnection();
    subscribingConnection.subscribeGate = subscribeGate;
    const subscribingSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(subscribingConnection),
    );
    const subscribingStart = subscribingSession.start();
    await flushAsyncWork();
    await subscribingSession.stop();
    assert.equal(subscribingConnection.closeCalls, 1);
    subscribeGate.resolve();
    await assert.rejects(subscribingStart, /stopped during startup/);

    const publishGate = new Deferred<void>();
    const refreshingConnection = new FakeMqttConnection();
    refreshingConnection.publishGate = publishGate;
    const refreshingSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(refreshingConnection),
    );
    const refreshingStart = refreshingSession.start();
    await flushAsyncWork();
    await refreshingSession.stop();
    assert.equal(refreshingConnection.closeCalls, 1);
    publishGate.resolve();
    await assert.rejects(refreshingStart, /stopped during startup/);

    const reconnectGate = new Deferred<void>();
    const reconnectingConnection = new FakeMqttConnection();
    const reconnectingSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(reconnectingConnection),
    );
    await reconnectingSession.start();
    reconnectingConnection.subscribeGate = reconnectGate;
    reconnectingConnection.emitDisconnect();
    reconnectingConnection.emitConnect();
    await flushAsyncWork();
    await completesWithin(reconnectingSession.stop(), 100);
    assert.equal(reconnectingConnection.closeCalls, 1);
    assert.equal(reconnectingSession.state, 'stopped');
  });

  it('bounds a hanging force-close operation', async () => {
    const closeGate = new Deferred<void>();
    const connection = new FakeMqttConnection();
    connection.closeGate = closeGate;
    const logger = new CapturingLogger();
    const session = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(connection),
      logger,
      undefined,
      10,
    );
    await session.start();
    const firstStop = session.stop();
    const joinedStop = session.stop();
    assert.equal(joinedStop, firstStop);
    await firstStop;
    assert.equal(session.state, 'stopped');
    assert.equal(connection.closeCalls, 1);
    assert.equal(logger.messages.includes('EcoFlow MQTT connection did not close cleanly'), true);
    closeGate.resolve();
  });

  it('bounds hanging subscription and refresh operations', async () => {
    const subscribeGate = new Deferred<void>();
    const subscribingConnection = new FakeMqttConnection();
    subscribingConnection.subscribeGate = subscribeGate;
    const subscribingSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(subscribingConnection),
      new CapturingLogger(),
      undefined,
      10,
    );
    await assert.rejects(subscribingSession.start(), /subscription failed/);
    assert.equal(subscribingConnection.closeCalls, 1);
    subscribeGate.resolve();

    const publishGate = new Deferred<void>();
    const refreshingConnection = new FakeMqttConnection();
    refreshingConnection.publishGate = publishGate;
    const refreshingSession = new EcoFlowCloudSession(
      testConfig(),
      successfulHttp(),
      new FakeMqttTransport(refreshingConnection),
      new CapturingLogger(),
      undefined,
      10,
    );
    await assert.rejects(refreshingSession.start(), /state refresh failed/);
    assert.equal(refreshingConnection.closeCalls, 1);
    publishGate.resolve();
  });

  it('builds a clean TLS-verified MQTT.js connection', () => {
    const options = buildMqttClientOptions({
      host: 'mqtt.example.test',
      port: 8883,
      username: 'TEST_MQTT_ACCOUNT',
      password: 'TEST_MQTT_PASSWORD',
      clientId: 'TEST_CLIENT',
    });
    assert.equal(options.clean, true);
    assert.equal(options.keepalive, 15);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.resubscribe, false);
    assert.equal(options.reconnectPeriod, 0);
    for (const forbiddenRoutingField of [
      'protocol',
      'host',
      'port',
      'servers',
      'auth',
      'query',
      'manualConnect',
    ]) {
      assert.equal(Object.hasOwn(options, forbiddenRoutingField), false);
    }
    options.log?.(
      'TEST_MQTT_ACCOUNT',
      'TEST_MQTT_PASSWORD',
      '/app/TEST_USER/TESTWAVE30001/thing/property/set',
      Uint8Array.of(1, 2, 3),
    );
  });
});

class FakeHttpTransport implements HttpTransport {
  public readonly requests: HttpRequest[] = [];

  constructor(private readonly responses: readonly HttpResponse[]) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) {
      throw new Error('unexpected HTTP request');
    }
    return response;
  }
}

class FakeMqttTransport implements MqttTransport {
  public credentials?: EcoFlowMqttCredentials;

  constructor(private readonly connection: FakeMqttConnection) {}

  async open(credentials: EcoFlowMqttCredentials): Promise<MqttConnection> {
    this.credentials = credentials;
    return this.connection;
  }
}

class FakeMqttConnection implements MqttConnection {
  public readonly subscribeCalls: string[][] = [];
  public readonly publishCalls: Array<{ topic: string; payload: Uint8Array | string }> = [];
  public readonly closeForces: Array<boolean | undefined> = [];
  public closeCalls = 0;
  public failSubscribe = false;
  public failPublish = false;
  public ignoreOperationAbort = false;
  public subscribeGate?: Deferred<void>;
  public publishGate?: Deferred<void>;
  public closeGate?: Deferred<void>;
  private readonly connectListeners = new Set<() => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: MqttMessage) => void>();

  onConnect(listener: () => void): () => void {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  onMessage(listener: (message: MqttMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  async subscribe(topics: readonly string[], signal?: AbortSignal): Promise<void> {
    this.subscribeCalls.push([...topics]);
    await waitForGate(this.subscribeGate?.promise, signal, this.ignoreOperationAbort);
    if (this.failSubscribe) {
      throw new Error('TEST_MQTT_PASSWORD TESTWAVE30001');
    }
  }

  async publish(
    topic: string,
    payload: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void> {
    await waitForGate(this.publishGate?.promise, signal, this.ignoreOperationAbort);
    if (this.failPublish) {
      throw new Error('TEST_MQTT_PASSWORD TESTWAVE30001');
    }
    this.publishCalls.push({ topic, payload });
  }

  async close(force?: boolean): Promise<void> {
    this.closeCalls += 1;
    this.closeForces.push(force);
    await this.closeGate?.promise;
  }

  emitConnect(): void {
    for (const listener of this.connectListeners) {
      listener();
    }
  }

  emitDisconnect(): void {
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }

  emitMessage(message: MqttMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  totalListenerCount(): number {
    return this.connectListeners.size
      + this.disconnectListeners.size
      + this.messageListeners.size;
  }
}

class CapturingLogger implements CloudSessionLogger {
  public readonly messages: string[] = [];

  debug(message: string): void {
    this.messages.push(message);
  }

  info(message: string): void {
    this.messages.push(message);
  }

  warn(message: string): void {
    this.messages.push(message);
  }

  error(message: string): void {
    this.messages.push(message);
  }
}

function testConfig() {
  return parseEcoFlowWave3Config({
    name: 'EcoFlow WAVE 3',
    email: 'owner@example.test',
    password: 'TEST_ACCOUNT_PASSWORD',
    apiHost: 'api.ecoflow.com',
    devices: [
      { name: 'Bedroom', serialNumber: 'TESTWAVE30001' },
      { name: 'Office', serialNumber: 'TESTWAVE30002' },
    ],
  });
}

function successfulHttp(): FakeHttpTransport {
  return new FakeHttpTransport([
    {
      status: 200,
      json: {
        message: 'Success',
        data: {
          token: 'TEST_TOKEN',
          user: { userId: 'TEST_USER' },
        },
      },
    },
    {
      status: 200,
      json: {
        message: 'Success',
        data: {
          url: 'mqtt.example.test',
          port: 8883,
          certificateAccount: 'TEST_MQTT_ACCOUNT',
          certificatePassword: 'TEST_MQTT_PASSWORD',
        },
      },
    },
  ]);
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function displayPacket(
  sequence: number,
  mode: number,
  ambientTemperature: number,
  targetTemperature: number,
): Uint8Array {
  const modeParameters = Array.from({ length: mode + 1 }, () => ({}));
  modeParameters[mode] = { tempSet: targetTemperature };
  return wave3Envelope(
    21,
    sequence,
    toBinary(Wave3DisplayPropertyUploadSchema, create(
      Wave3DisplayPropertyUploadSchema,
      {
        devSleepState: 0,
        waveOperatingMode: mode,
        tempAmbient: ambientTemperature,
        waveModeInfo: { listInfo: modeParameters },
      },
    )),
  );
}

function runtimePacket(sequence: number, condenserTemperature: number): Uint8Array {
  return wave3Envelope(
    22,
    sequence,
    toBinary(Wave3RuntimePropertyUploadSchema, create(
      Wave3RuntimePropertyUploadSchema,
      { tempCondenser: condenserTemperature },
    )),
  );
}

function humidityPacket(sequence: number, humidityPercent: number): Uint8Array {
  return wave3Envelope(
    21,
    sequence,
    toBinary(Wave3DisplayPropertyUploadSchema, create(
      Wave3DisplayPropertyUploadSchema,
      { humiAmbient: humidityPercent },
    )),
  );
}

function wave3Envelope(
  commandId: number,
  sequence: number,
  payload: Uint8Array,
): Uint8Array {
  return toBinary(Wave3SetMessageSchema, create(Wave3SetMessageSchema, {
    header: {
      pdata: payload,
      src: 32,
      dest: 66,
      cmdFunc: 254,
      cmdId: commandId,
      dataLen: payload.length,
      seq: sequence,
    },
  }));
}

async function completesWithin(promise: Promise<void>, milliseconds: number): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('operation did not complete promptly')), milliseconds);
    }),
  ]);
}

function neverUntilAborted<T>(signal?: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('operation cancelled'));
      return;
    }
    signal?.addEventListener(
      'abort',
      () => reject(new Error('operation cancelled')),
      { once: true },
    );
  });
}

async function waitForGate(
  gate: Promise<void> | undefined,
  signal: AbortSignal | undefined,
  ignoreAbort: boolean,
): Promise<void> {
  if (gate === undefined) {
    return;
  }
  if (ignoreAbort) {
    await gate;
    return;
  }
  await Promise.race([gate, neverUntilAborted(signal)]);
}

function sequentialRequestIds(): () => string {
  let next = 999_910_001;
  return () => String(next++);
}

class Deferred<T> {
  public readonly promise: Promise<T>;
  private resolvePromise!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>(resolve => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value?: T): void {
    this.resolvePromise(value as T);
  }
}
