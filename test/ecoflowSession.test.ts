import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

const EXPECTED_REFRESH_PAYLOAD = JSON.stringify({
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
    const session = new EcoFlowCloudSession(testConfig(), http, mqtt);
    const messages: Wave3InboundMessage[] = [];
    session.onMessage(message => messages.push(message));

    await session.start();

    assert.equal(session.state, 'online');
    assert.equal(mqtt.credentials?.host, 'mqtt.example.test');
    assert.equal(connection.subscribeCalls.length, 1);
    assert.deepEqual(
      connection.subscribeCalls[0],
      [
        ...Object.values(buildWave3Topics('TEST_USER', 'TESTWAVE30001')),
        ...Object.values(buildWave3Topics('TEST_USER', 'TESTWAVE30002')),
      ],
    );
    assert.equal(connection.publishCalls.length, 2);
    assert.equal(connection.publishCalls[0]?.topic.endsWith('/thing/property/get'), true);
    assert.equal(connection.publishCalls[0]?.payload, EXPECTED_REFRESH_PAYLOAD);

    const propertyTopic = buildWave3Topics('TEST_USER', 'TESTWAVE30002').property;
    connection.emitMessage({ topic: propertyTopic, payload: Uint8Array.of(1, 2) });
    assert.deepEqual(messages, [{
      serialNumber: 'TESTWAVE30002',
      kind: 'property',
      payload: Uint8Array.of(1, 2),
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

    await session.stop();
    await session.stop();
    assert.equal(session.state, 'stopped');
    assert.equal(connection.closeCalls, 1);
    assert.equal(connection.totalListenerCount(), 0);
  });

  it('re-subscribes and refreshes exactly once per reconnect without duplicating listeners', async () => {
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
    assert.equal(connection.subscribeCalls.length, 2);
    assert.equal(connection.publishCalls.length, 4);
    assert.equal(connection.totalListenerCount(), 3);
    await session.stop();
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

    assert.equal(session.state, 'offline');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, 'EcoFlow MQTT reconnect setup failed');
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

  it('builds a clean TLS-verified MQTT.js connection', () => {
    const options = buildMqttClientOptions(
      {
        host: 'mqtt.example.test',
        port: 8883,
        username: 'TEST_MQTT_ACCOUNT',
        password: 'TEST_MQTT_PASSWORD',
        clientId: 'TEST_CLIENT',
      },
      {
        clean: false,
        keepalive: 60,
        rejectUnauthorized: false,
      },
    );
    assert.equal(options.clean, true);
    assert.equal(options.keepalive, 15);
    assert.equal(options.rejectUnauthorized, true);
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
  public closeCalls = 0;
  public failSubscribe = false;
  public failPublish = false;
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

  async subscribe(topics: readonly string[]): Promise<void> {
    this.subscribeCalls.push([...topics]);
    if (this.failSubscribe) {
      throw new Error('TEST_MQTT_PASSWORD TESTWAVE30001');
    }
  }

  async publish(topic: string, payload: Uint8Array | string): Promise<void> {
    if (this.failPublish) {
      throw new Error('TEST_MQTT_PASSWORD TESTWAVE30001');
    }
    this.publishCalls.push({ topic, payload });
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
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
