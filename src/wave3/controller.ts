import type {
  CloudSessionState,
  EcoFlowCloudSessionError,
  Wave3InboundMessage,
} from '../ecoflow/session.js';
import {
  decodeWave3Message,
  encodeWave3Command,
  mergeWave3DisplayUpdate,
} from './codec.js';
import type {
  Wave3Acknowledgement,
  Wave3Command,
  Wave3CommandFailure,
  Wave3CommandResult,
  Wave3ControllerSnapshot,
  Wave3DisplayState,
  Wave3DisplayUpdate,
  Wave3RuntimeTemperatures,
  Wave3State,
} from './domain.js';

export interface Wave3ControllerSession {
  readonly state: CloudSessionState;
  onMessage(listener: (message: Wave3InboundMessage) => void): () => void;
  onError(listener: (error: EcoFlowCloudSessionError) => void): () => void;
  onStateChange(listener: (state: CloudSessionState) => void): () => void;
  publishCommand(
    serialNumber: string,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  requestState(serialNumber: string): Promise<void>;
}

export interface Wave3ControllerOptions {
  commandTimeoutMilliseconds?: number;
  staleAfterMilliseconds?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMilliseconds: number) => () => void;
  initialSequence?: number;
}

interface PendingCommand {
  command: Wave3Command;
  sequence: number;
  publicationCompleted: boolean;
  publicationController: AbortController;
  acknowledgement?: Wave3Acknowledgement;
  acknowledgementAmbiguous: boolean;
  acknowledgementRevision?: number;
  observedStateConfirmed: boolean;
  resolve: (result: Wave3CommandResult) => void;
  cancelTimeout: () => void;
}

const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_STALE_AFTER_MILLISECONDS = 120_000;

export class Wave3Controller {
  private displayState?: Wave3DisplayState;
  private runtimeTemperatures: Wave3RuntimeTemperatures = {};
  private readonly snapshotListeners = new Set<(snapshot: Wave3ControllerSnapshot) => void>();
  private readonly detachListeners: Array<() => void>;
  private pending?: PendingCommand;
  private commandTail: Promise<void> = Promise.resolve();
  private cancelStaleTimer?: () => void;
  private readonly activePublications = new Set<Promise<void>>();
  private updatedAt?: number;
  private displayRevision = 0;
  private lastDisplaySequence?: number;
  private lastRuntimeSequence?: number;
  private nextSequence: number;
  private stopped = false;

  public snapshot: Wave3ControllerSnapshot;

  private readonly commandTimeoutMilliseconds: number;
  private readonly staleAfterMilliseconds: number;
  private readonly now: () => number;
  private readonly schedule: (
    callback: () => void,
    delayMilliseconds: number,
  ) => () => void;

  constructor(
    private readonly serialNumber: string,
    private readonly session: Wave3ControllerSession,
    options: Wave3ControllerOptions = {},
  ) {
    this.commandTimeoutMilliseconds = options.commandTimeoutMilliseconds
      ?? DEFAULT_COMMAND_TIMEOUT_MILLISECONDS;
    this.staleAfterMilliseconds = options.staleAfterMilliseconds
      ?? DEFAULT_STALE_AFTER_MILLISECONDS;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.nextSequence = options.initialSequence ?? 10;
    this.snapshot = freezeSnapshot({
      availability: availabilityForSession(session.state, false),
      state: {},
      runtimeTemperatures: {},
    });
    this.detachListeners = [
      session.onMessage(message => this.handleMessage(message)),
      session.onError(() => this.handleSessionFailure()),
      session.onStateChange(state => this.handleSessionState(state)),
    ];
  }

  onSnapshot(listener: (snapshot: Wave3ControllerSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  execute(command: Wave3Command): Promise<Wave3CommandResult> {
    const execution = this.commandTail.then(() => this.executeNow(command));
    this.commandTail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const detach of this.detachListeners) {
      detach();
    }
    this.cancelStaleTimer?.();
    this.cancelStaleTimer = undefined;
    this.settlePending('stopped');
    this.updateSnapshot('stopped');
  }

  private async executeNow(command: Wave3Command): Promise<Wave3CommandResult> {
    const sequence = this.takeSequence();
    if (this.stopped || this.session.state === 'stopped') {
      return { status: 'failed', sequence, reason: 'stopped' };
    }
    if (this.session.state !== 'online') {
      return { status: 'failed', sequence, reason: 'disconnected' };
    }
    if (this.activePublications.size > 0) {
      return { status: 'failed', sequence, reason: 'disconnected' };
    }

    const encoded = encodeWave3Command(this.serialNumber, sequence, command);
    const publicationController = new AbortController();
    const result = new Promise<Wave3CommandResult>(resolve => {
      const cancelTimeout = this.schedule(() => {
        this.settlePending('timeout');
      }, this.commandTimeoutMilliseconds);
      this.pending = {
        command,
        sequence,
        publicationCompleted: false,
        publicationController,
        acknowledgementAmbiguous: false,
        observedStateConfirmed: false,
        resolve,
        cancelTimeout,
      };
    });

    let publication: Promise<void>;
    try {
      publication = this.session.publishCommand(
        this.serialNumber,
        encoded.bytes,
        publicationController.signal,
      );
    } catch {
      this.settlePending('publicationFailed');
      return result;
    }
    this.activePublications.add(publication);
    void publication.then(
      () => {
        this.activePublications.delete(publication);
        this.handlePublicationSuccess(sequence);
      },
      () => {
        this.activePublications.delete(publication);
        if (this.pending?.sequence === sequence) {
          this.settlePending('publicationFailed');
        }
      },
    );
    return result;
  }

  private handlePublicationSuccess(sequence: number): void {
    const pending = this.pending;
    if (pending === undefined || pending.sequence !== sequence) {
      return;
    }
    pending.publicationCompleted = true;
    if (pending.acknowledgement !== undefined) {
      this.applyAcknowledgement(pending);
    }
  }

  private handleMessage(message: Wave3InboundMessage): void {
    if (this.stopped || message.serialNumber !== this.serialNumber) {
      return;
    }
    const decoded = decodeWave3Message(message.payload);
    if (decoded.kind === 'display') {
      if (!isNewerSequence(decoded.sequence, this.lastDisplaySequence)) {
        return;
      }
      this.lastDisplaySequence = decoded.sequence;
      this.displayState = mergeWave3DisplayUpdate(this.displayState, decoded.update);
      this.displayRevision += 1;
      this.markFresh();
      this.confirmPendingFromObservedState(decoded.update);
      return;
    }
    if (decoded.kind === 'runtime') {
      if (!isNewerSequence(decoded.sequence, this.lastRuntimeSequence)) {
        return;
      }
      this.lastRuntimeSequence = decoded.sequence;
      this.runtimeTemperatures = {
        ...this.runtimeTemperatures,
        ...decoded.temperatures,
      };
      this.markFresh();
      return;
    }
    if (decoded.kind === 'acknowledgement') {
      this.handleAcknowledgement(decoded.sequence, decoded.acknowledgement);
    }
  }

  private handleAcknowledgement(
    sequence: number,
    acknowledgement: Wave3Acknowledgement,
  ): void {
    const pending = this.pending;
    if (pending === undefined || pending.sequence !== sequence) {
      return;
    }
    if (pending.acknowledgement !== undefined) {
      if (acknowledgementsEqual(pending.acknowledgement, acknowledgement)) {
        return;
      }
      pending.acknowledgementAmbiguous = true;
      pending.observedStateConfirmed = false;
      if (pending.publicationCompleted) {
        this.settlePending('acknowledgementRejected');
      }
      return;
    }
    pending.acknowledgement = acknowledgement;
    pending.acknowledgementRevision = this.displayRevision;
    if (pending.publicationCompleted) {
      this.applyAcknowledgement(pending);
    }
  }

  private applyAcknowledgement(pending: PendingCommand): void {
    const acknowledgement = pending.acknowledgement;
    if (acknowledgement === undefined) {
      return;
    }
    if (pending.acknowledgementAmbiguous
      || acknowledgement.reportedConfigOk !== true
      || !acknowledgementMatchesCommand(acknowledgement, pending.command)) {
      this.settlePending('acknowledgementRejected');
      return;
    }
    if (pending.observedStateConfirmed) {
      this.settlePending(undefined);
      return;
    }
    void this.session.requestState(this.serialNumber).catch(() => {
      this.settlePending('disconnected');
    });
  }

  private confirmPendingFromObservedState(update: Wave3DisplayUpdate): void {
    const pending = this.pending;
    if (pending?.acknowledgement === undefined
      || pending.acknowledgementRevision === undefined
      || this.displayRevision <= pending.acknowledgementRevision
      || !updateProvidesCommandEvidence(update, this.displayState, pending.command)
      || !stateMatchesCommand(this.displayState?.state ?? {}, pending.command)) {
      return;
    }
    pending.observedStateConfirmed = true;
    if (pending.publicationCompleted) {
      this.settlePending(undefined);
    }
  }

  private handleSessionState(state: CloudSessionState): void {
    if (this.stopped) {
      return;
    }
    if (state === 'offline' || state === 'starting') {
      this.cancelStaleTimer?.();
      this.cancelStaleTimer = undefined;
      this.lastDisplaySequence = undefined;
      this.lastRuntimeSequence = undefined;
      if (this.pending?.publicationCompleted !== false) {
        this.settlePending('disconnected');
      }
      this.updateSnapshot('reconnecting');
      return;
    }
    if (state === 'failed') {
      if (this.pending?.publicationCompleted !== false) {
        this.settlePending('disconnected');
      }
      this.updateSnapshot('offline');
      return;
    }
    if (state === 'stopped') {
      this.stop();
      return;
    }
    if (state === 'online') {
      this.updateFreshnessForOnlineSession();
    }
  }

  private handleSessionFailure(): void {
    if (!this.stopped) {
      this.settlePending('disconnected');
      this.updateSnapshot('offline');
    }
  }

  private markFresh(): void {
    this.updatedAt = this.now();
    this.updateFreshnessForOnlineSession();
  }

  private updateFreshnessForOnlineSession(): void {
    this.cancelStaleTimer?.();
    this.cancelStaleTimer = undefined;
    if (this.session.state !== 'online' || this.updatedAt === undefined) {
      this.updateSnapshot(this.session.state === 'online' ? 'stale' : 'reconnecting');
      return;
    }
    const remaining = this.staleAfterMilliseconds - (this.now() - this.updatedAt);
    if (remaining <= 0) {
      this.updateSnapshot('stale');
      return;
    }
    this.cancelStaleTimer = this.schedule(() => {
      if (!this.stopped && this.session.state === 'online') {
        this.updateSnapshot('stale');
      }
    }, remaining);
    this.updateSnapshot('online');
  }

  private updateSnapshot(availability: Wave3ControllerSnapshot['availability']): void {
    this.snapshot = freezeSnapshot({
      availability,
      state: this.displayState?.state ?? {},
      runtimeTemperatures: this.runtimeTemperatures,
      updatedAt: this.updatedAt,
    });
    for (const listener of this.snapshotListeners) {
      listener(this.snapshot);
    }
  }

  private settlePending(reason: Wave3CommandFailure | undefined): void {
    const pending = this.pending;
    if (pending === undefined) {
      return;
    }
    this.pending = undefined;
    pending.cancelTimeout();
    if (!pending.publicationCompleted) {
      pending.publicationController.abort();
    }
    pending.resolve(reason === undefined
      ? { status: 'confirmed', sequence: pending.sequence }
      : { status: 'failed', sequence: pending.sequence, reason });
  }

  private takeSequence(): number {
    const sequence = this.nextSequence;
    this.nextSequence = sequence >= 999 ? 10 : sequence + 1;
    return sequence;
  }
}

function acknowledgementMatchesCommand(
  acknowledgement: Wave3Acknowledgement,
  command: Wave3Command,
): boolean {
  const values = acknowledgement.values;
  switch (command.type) {
  case 'power':
    return command.on ? values.mainPower === true : values.systemPaused === true;
  case 'mode':
    return values.mainPower === true && values.mode === command.mode;
  case 'targetTemperature':
    return closeEnough(values.targetTemperatureCelsius, command.celsius);
  case 'automaticTemperatureRange':
    return closeEnough(values.targetTemperatureLowerCelsius, command.lowerCelsius)
      && closeEnough(values.targetTemperatureUpperCelsius, command.upperCelsius);
  case 'airflowSpeed':
    return values.airflowSpeed === command.speed;
  case 'submode':
    return values.submode === command.submode;
  }
}

function acknowledgementsEqual(
  left: Wave3Acknowledgement,
  right: Wave3Acknowledgement,
): boolean {
  if (left.actionId !== right.actionId
    || left.reportedConfigOk !== right.reportedConfigOk) {
    return false;
  }
  const keys = new Set([
    ...Object.keys(left.values),
    ...Object.keys(right.values),
  ] as Array<keyof Wave3Acknowledgement['values']>);
  for (const key of keys) {
    if (left.values[key] !== right.values[key]) {
      return false;
    }
  }
  return true;
}

function stateMatchesCommand(state: Wave3State, command: Wave3Command): boolean {
  switch (command.type) {
  case 'power':
    return state.powered === command.on;
  case 'mode':
    return state.powered === true && state.mode === command.mode;
  case 'targetTemperature':
    return closeEnough(state.targetTemperatureCelsius, command.celsius);
  case 'automaticTemperatureRange':
    return closeEnough(state.targetTemperatureLowerCelsius, command.lowerCelsius)
      && closeEnough(state.targetTemperatureUpperCelsius, command.upperCelsius);
  case 'airflowSpeed':
    return state.airflowSpeed === command.speed;
  case 'submode':
    return state.submode === command.submode;
  }
}

function updateProvidesCommandEvidence(
  update: Wave3DisplayUpdate,
  displayState: Wave3DisplayState | undefined,
  command: Wave3Command,
): boolean {
  const activeModeId = update.operatingModeId ?? displayState?.operatingModeId;
  const parameters = activeModeId === undefined
    ? undefined
    : update.modeParameters[activeModeId];
  switch (command.type) {
  case 'power':
    return command.on
      ? update.sleepState === 0
        || (update.operatingModeId !== undefined && update.operatingModeId !== 0)
      : update.sleepState === 1 || update.operatingModeId === 0;
  case 'mode':
    return update.operatingModeId !== undefined;
  case 'targetTemperature':
    return parameters?.targetTemperatureCelsius !== undefined;
  case 'automaticTemperatureRange':
    return parameters?.targetTemperatureLowerCelsius !== undefined
      && parameters.targetTemperatureUpperCelsius !== undefined;
  case 'airflowSpeed':
    return parameters?.airflowSpeed !== undefined;
  case 'submode':
    return parameters?.submode !== undefined;
  }
}

function closeEnough(actual: number | undefined, expected: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) < 0.01;
}

function isNewerSequence(candidate: number, previous: number | undefined): boolean {
  if (previous === undefined) {
    return true;
  }
  const difference = (candidate - previous) >>> 0;
  return difference > 0 && difference < 0x8000_0000;
}

function availabilityForSession(
  state: CloudSessionState,
  hasFreshState: boolean,
): Wave3ControllerSnapshot['availability'] {
  switch (state) {
  case 'online':
    return hasFreshState ? 'online' : 'stale';
  case 'starting':
  case 'offline':
    return 'reconnecting';
  case 'failed':
  case 'idle':
    return 'offline';
  case 'stopped':
    return 'stopped';
  }
}

function freezeSnapshot(
  snapshot: Omit<Wave3ControllerSnapshot, 'state' | 'runtimeTemperatures'> & {
    state: Wave3State;
    runtimeTemperatures: Wave3RuntimeTemperatures;
  },
): Wave3ControllerSnapshot {
  return Object.freeze({
    ...snapshot,
    state: Object.freeze({ ...snapshot.state }),
    runtimeTemperatures: Object.freeze({ ...snapshot.runtimeTemperatures }),
  });
}

function defaultSchedule(callback: () => void, delayMilliseconds: number): () => void {
  const timer = setTimeout(callback, delayMilliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}
