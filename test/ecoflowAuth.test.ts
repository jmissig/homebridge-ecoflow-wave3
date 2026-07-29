import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authenticateEcoFlow,
  EcoFlowAuthenticationError,
} from '../src/ecoflow/auth.js';
import { parseEcoFlowWave3Config } from '../src/ecoflow/config.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../src/ecoflow/http.js';
import { prepareHttpRequest } from '../src/ecoflow/http.js';

describe('EcoFlow private authentication', () => {
  it('logs in, requests certification, and parses temporary MQTT credentials', async () => {
    const http = new FakeHttpTransport([
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
            url: 'mqtts://mqtt.example.test',
            port: '8883',
            certificateAccount: 'TEST_MQTT_ACCOUNT',
            certificatePassword: 'TEST_MQTT_PASSWORD',
          },
        },
      },
    ]);

    const authenticated = await authenticateEcoFlow(
      testConfig(),
      http,
      () => 'abcdef',
    );

    assert.deepEqual(authenticated, {
      userId: 'TEST_USER',
      token: 'TEST_TOKEN',
      mqtt: {
        host: 'mqtt.example.test',
        port: 8883,
        username: 'TEST_MQTT_ACCOUNT',
        password: 'TEST_MQTT_PASSWORD',
        clientId: 'ANDROID_ABCDEF_TEST_USER',
      },
    });
    assert.equal(http.requests.length, 2);
    assert.equal(http.requests[0]?.method, 'POST');
    assert.equal(http.requests[0]?.url.href, 'https://api.ecoflow.com/auth/login');
    assert.deepEqual(http.requests[0]?.body, {
      type: 'json',
      value: {
        email: 'owner@example.test',
        password: Buffer.from('TEST_ACCOUNT_PASSWORD').toString('base64'),
        scene: 'IOT_APP',
        userType: 'ECOFLOW',
      },
    });
    assert.equal(http.requests[1]?.method, 'GET');
    assert.equal(
      http.requests[1]?.url.href,
      'https://api.ecoflow.com/iot-auth/app/certification',
    );
    assert.equal(http.requests[1]?.headers.authorization, 'Bearer TEST_TOKEN');
    assert.deepEqual(http.requests[1]?.body, {
      type: 'form',
      fields: { userId: 'TEST_USER' },
    });

    const certificationRequest = prepareHttpRequest(http.requests[1]!);
    assert.equal(certificationRequest.method, 'GET');
    assert.equal(certificationRequest.url.pathname, '/iot-auth/app/certification');
    assert.equal(
      certificationRequest.headers['content-type'],
      'application/json',
    );
    assert.equal(certificationRequest.headers['content-length'], '16');
    assert.equal(certificationRequest.body?.toString('utf8'), 'userId=TEST_USER');
  });

  it('returns bounded errors for invalid credentials and malformed certification', async () => {
    const invalidCredentials = new FakeHttpTransport([
      { status: 401, json: { secret: 'must-not-appear' } },
    ]);
    await assert.rejects(
      authenticateEcoFlow(testConfig(), invalidCredentials),
      (error: unknown) => {
        assert.equal(error instanceof EcoFlowAuthenticationError, true);
        assert.equal((error as Error).message, 'EcoFlow login failed with HTTP status 401');
        assert.equal((error as Error).message.includes('must-not-appear'), false);
        return true;
      },
    );

    const malformedCertification = new FakeHttpTransport([
      successfulLogin(),
      { status: 200, json: { message: 'Success', data: {} } },
    ]);
    await assert.rejects(
      authenticateEcoFlow(testConfig(), malformedCertification),
      /omitted MQTT broker host/,
    );
  });

  it('does not propagate transport errors containing secrets', async () => {
    const http: HttpTransport = {
      request: async () => {
        throw new Error(
          'owner@example.test TEST_ACCOUNT_PASSWORD TESTWAVE30001 TEST_TOKEN',
        );
      },
    };

    await assert.rejects(
      authenticateEcoFlow(testConfig(), http),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.equal(message, 'EcoFlow login request failed');
        assert.equal(message.includes('owner@example.test'), false);
        assert.equal(message.includes('TEST_ACCOUNT_PASSWORD'), false);
        return true;
      },
    );
  });

  it('uses the selected regional host and bounds a wrong-region response', async () => {
    const http = new FakeHttpTransport([
      { status: 404, json: { message: 'account is in another region' } },
    ]);
    await assert.rejects(
      authenticateEcoFlow(testConfig({ apiHost: 'api-e.ecoflow.com' }), http),
      /HTTP status 404/,
    );
    assert.equal(http.requests[0]?.url.hostname, 'api-e.ecoflow.com');
  });
});

class FakeHttpTransport implements HttpTransport {
  public readonly requests: HttpRequest[] = [];

  constructor(private readonly responses: readonly HttpResponse[]) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) {
      throw new Error('unexpected request');
    }
    return response;
  }
}

function testConfig(overrides: Record<string, unknown> = {}) {
  return parseEcoFlowWave3Config({
    name: 'EcoFlow WAVE 3',
    email: 'owner@example.test',
    password: 'TEST_ACCOUNT_PASSWORD',
    apiHost: 'api.ecoflow.com',
    devices: [{ name: 'Bedroom', serialNumber: 'TESTWAVE30001' }],
    ...overrides,
  });
}

function successfulLogin(): HttpResponse {
  return {
    status: 200,
    json: {
      message: 'Success',
      data: {
        token: 'TEST_TOKEN',
        user: { userId: 'TEST_USER' },
      },
    },
  };
}
