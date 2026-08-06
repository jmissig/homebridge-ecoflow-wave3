import { request as httpsRequest } from 'node:https';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: URL;
  headers: Readonly<Record<string, string>>;
  body?: HttpRequestBody;
}

export type HttpRequestBody =
  | { type: 'json'; value: unknown }
  | { type: 'form'; fields: Readonly<Record<string, string>> };

export interface EncodedHttpBody {
  bytes: Buffer;
  contentType: string;
}

export interface PreparedHttpRequest {
  method: HttpRequest['method'];
  url: URL;
  headers: Readonly<Record<string, string>>;
  body?: Buffer;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

export interface HttpTransport {
  request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

export class NodeHttpsTransport implements HttpTransport {
  constructor(
    private readonly timeoutMilliseconds = 15_000,
    private readonly maximumResponseBytes = 1_048_576,
    private readonly requester: typeof httpsRequest = httpsRequest,
  ) {}

  async request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    const prepared = prepareHttpRequest(request);
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(new Error('request deadline reached')),
      this.timeoutMilliseconds,
    );
    const requestSignal = signal === undefined
      ? deadlineController.signal
      : AbortSignal.any([signal, deadlineController.signal]);

    try {
      return await new Promise<HttpResponse>((resolve, reject) => {
        const clientRequest = this.requester(prepared.url, {
          method: prepared.method,
          headers: prepared.headers,
          rejectUnauthorized: true,
          signal: requestSignal,
        }, response => {
          const chunks: Buffer[] = [];
          let receivedBytes = 0;

          response.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (receivedBytes > this.maximumResponseBytes) {
              clientRequest.destroy(new Error('response too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve({
                status: response.statusCode ?? 0,
                json: JSON.parse(text) as unknown,
              });
            } catch {
              reject(new Error('invalid JSON response'));
            }
          });
          response.on('aborted', () => reject(new Error('response aborted')));
          response.on('error', reject);
        });

        clientRequest.on('error', reject);
        if (prepared.body !== undefined) {
          clientRequest.write(prepared.body);
        }
        clientRequest.end();
      });
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}

export function prepareHttpRequest(request: HttpRequest): PreparedHttpRequest {
  const body = encodeHttpRequestBody(request.body);
  return {
    method: request.method,
    url: request.url,
    headers: {
      ...(body === undefined ? {} : {
        'content-type': body.contentType,
      }),
      ...request.headers,
      ...(body === undefined ? {} : { 'content-length': String(body.bytes.length) }),
    },
    ...(body === undefined ? {} : { body: body.bytes }),
  };
}

export function encodeHttpRequestBody(body: HttpRequestBody | undefined): EncodedHttpBody | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (body.type === 'json') {
    return {
      bytes: Buffer.from(JSON.stringify(body.value), 'utf8'),
      contentType: 'application/json',
    };
  }
  return {
    bytes: Buffer.from(new URLSearchParams(body.fields).toString(), 'utf8'),
    contentType: 'application/x-www-form-urlencoded',
  };
}
