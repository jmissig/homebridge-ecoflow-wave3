import { request as httpsRequest } from 'node:https';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: URL;
  headers: Readonly<Record<string, string>>;
  jsonBody?: unknown;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export class NodeHttpsTransport implements HttpTransport {
  constructor(
    private readonly timeoutMilliseconds = 15_000,
    private readonly maximumResponseBytes = 1_048_576,
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const body = request.jsonBody === undefined
      ? undefined
      : Buffer.from(JSON.stringify(request.jsonBody), 'utf8');

    return new Promise<HttpResponse>((resolve, reject) => {
      const clientRequest = httpsRequest(request.url, {
        method: request.method,
        headers: {
          ...request.headers,
          ...(body === undefined ? {} : { 'content-length': String(body.length) }),
        },
        rejectUnauthorized: true,
        timeout: this.timeoutMilliseconds,
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
      });

      clientRequest.on('timeout', () => clientRequest.destroy(new Error('request timed out')));
      clientRequest.on('error', reject);
      if (body !== undefined) {
        clientRequest.write(body);
      }
      clientRequest.end();
    });
  }
}
