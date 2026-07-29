import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import { describe, it } from 'node:test';

import { NodeHttpsTransport } from '../src/ecoflow/http.js';

describe('Node HTTPS transport', () => {
  it('rejects a response that is aborted before its JSON body completes', async () => {
    const requester = createRequester((_options, callback) => {
      const response = new EventEmitter() as IncomingMessage;
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => response.emit('aborted'));
    });
    const transport = new NodeHttpsTransport(1_000, 1_024, requester);

    await assert.rejects(
      transport.request(testRequest()),
      /response aborted/,
    );
  });

  it('enforces an absolute request deadline', async () => {
    const requester = createRequester((options, _callback, request) => {
      options.signal?.addEventListener('abort', () => {
        request.emit('error', new Error('request deadline reached'));
      }, { once: true });
    });
    const transport = new NodeHttpsTransport(10, 1_024, requester);

    await assert.rejects(
      transport.request(testRequest()),
      /deadline reached/,
    );
  });
});

interface TestRequestOptions {
  signal?: AbortSignal;
}

type TestResponseCallback = (response: IncomingMessage) => void;

function createRequester(
  onEnd: (
    options: TestRequestOptions,
    callback: TestResponseCallback,
    request: EventEmitter,
  ) => void,
): typeof httpsRequest {
  return ((
    _url: URL,
    options: TestRequestOptions,
    callback: TestResponseCallback,
  ) => {
    const request = new EventEmitter() as EventEmitter & {
      write: (chunk: Buffer) => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };
    request.write = () => undefined;
    request.destroy = error => {
      if (error !== undefined) {
        request.emit('error', error);
      }
    };
    request.end = () => onEnd(options, callback, request);
    return request;
  }) as unknown as typeof httpsRequest;
}

function testRequest() {
  return {
    method: 'GET' as const,
    url: new URL('https://api.ecoflow.com/test'),
    headers: {},
  };
}
