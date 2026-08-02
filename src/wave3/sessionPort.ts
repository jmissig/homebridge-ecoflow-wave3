import type {
  DecodedWave3Message,
  DecodedWave3QuotaReply,
} from './codec.js';

export interface CloudSessionLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type CloudSessionState =
  | 'idle'
  | 'starting'
  | 'online'
  | 'offline'
  | 'failed'
  | 'stopped';

export type Wave3InboundMessageKind = 'property' | 'setReply' | 'getReply';

interface Wave3InboundEventBase {
  serialNumber: string;
  generation: number;
  payloadLength: number;
}

export type Wave3InboundEvent =
  | Wave3InboundEventBase & {
    kind: 'property' | 'setReply';
    decoded: DecodedWave3Message;
  }
  | Wave3InboundEventBase & {
    kind: 'getReply';
    decoded: DecodedWave3QuotaReply;
  };

/** @deprecated Use Wave3InboundEvent. */
export type Wave3InboundMessage = Wave3InboundEvent;

export class EcoFlowCloudSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcoFlowCloudSessionError';
  }
}

export interface Wave3ControllerSession {
  readonly state: CloudSessionState;
  onMessage(listener: (event: Wave3InboundEvent) => void): () => void;
  onError(listener: (error: EcoFlowCloudSessionError) => void): () => void;
  onStateChange(listener: (state: CloudSessionState) => void): () => void;
  publishCommand(
    serialNumber: string,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  requestState(serialNumber: string): Promise<void>;
}
