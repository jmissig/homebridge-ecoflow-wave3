import { randomInt } from 'node:crypto';

import type {
  CloudSessionLogger,
  CloudSessionState,
  EcoFlowCloudSessionError,
  Wave3InboundMessage,
} from '../ecoflow/session.js';
import {
  decodeWave3QuotaReply,
  decodeWave3Message,
  encodeWave3Command,
  hasWave3ControlStateEvidence,
  hasWave3DisplayEvidence,
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
  Wave3FirmwareVersions,
  Wave3RuntimeTemperatures,
  Wave3State,
} from './domain.js';

export interface Wave3AccessoryController {
  readonly snapshot: Wave3ControllerSnapshot;
  onSnapshot(listener: (snapshot: Wave3ControllerSnapshot) => void): () => void;
  execute(command: Wave3Command): Promise<Wave3CommandResult>;
  stop(): void;
}

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
  logger?: CloudSessionLogger;
}

interface PendingCommand {
  command: Wave3Command;
  sequence: number;
  publicationCompleted: boolean;
  publicationController: AbortController;
  acknowledgement?: Wave3Acknowledgement;
  acknowledgementRejected: boolean;
  acknowledgementRevision?: number;
  observedStateConfirmed: boolean;
  stateRefreshRequested: boolean;
  resolve: (result: Wave3CommandResult) => void;
  cancelTimeout: () => void;
}

const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_STALE_AFTER_MILLISECONDS = 300_000;
const NOOP_LOGGER: CloudSessionLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class Wave3Controller {
  private displayState?: Wave3DisplayState;
  private runtimeTemperatures: Wave3RuntimeTemperatures = {};
  private firmwareVersions: Wave3FirmwareVersions = {};
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
  private activeGeneration?: number;
  private nextSequence: number;
  private stopped = false;
  private hasCurrentGenerationState = false;
  private deviceReportedOnline?: boolean;

  public snapshot: Wave3ControllerSnapshot;

  private readonly commandTimeoutMilliseconds: number;
  private readonly staleAfterMilliseconds: number;
  private readonly now: () => number;
  private readonly logger: CloudSessionLogger;
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
    this.logger = options.logger ?? NOOP_LOGGER;
    this.schedule = options.schedule ?? defaultSchedule;
    this.nextSequence = options.initialSequence ?? randomInt(10, 1_000);
    this.snapshot = freezeSnapshot({
      availability: availabilityForSession(session.state, false),
      state: {},
      runtimeTemperatures: {},
      firmwareVersions: {},
    });
    this.detachListeners = [
      session.onMessage(message => this.handleMessage(message)),
      session.onError(() => this.handleSessionFailure()),
      session.onStateChange(state => this.handleSessionState(state)),
    ];
    this.logger.debug(
      `EcoFlow diagnostics: WAVE 3 controller created (sessionState=${session.state}, initialAvailability=${this.snapshot.availability})`,
    );
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
    this.logger.debug(
      `EcoFlow diagnostics: controller command started sequence=${sequence} `
      + `command=${describeCommand(command)}`,
    );
    if (this.stopped || this.session.state === 'stopped') {
      return this.immediateCommandFailure(command, sequence, 'stopped');
    }
    if (this.session.state !== 'online' || this.snapshot.availability !== 'online') {
      return this.immediateCommandFailure(command, sequence, 'disconnected');
    }
    if (this.activePublications.size > 0) {
      return this.immediateCommandFailure(command, sequence, 'disconnected');
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
        acknowledgementRejected: false,
        observedStateConfirmed: false,
        stateRefreshRequested: false,
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
    this.logger.debug(
      `EcoFlow diagnostics: controller command publication accepted sequence=${sequence} `
      + `command=${describeCommand(pending.command)}`,
    );
    if (pending.acknowledgementRejected) {
      this.settlePending('acknowledgementRejected');
      return;
    }
    if (pending.acknowledgement !== undefined) {
      this.applyAcknowledgement(pending);
    }
  }

  private handleMessage(message: Wave3InboundMessage): void {
    if (this.stopped || message.serialNumber !== this.serialNumber) {
      return;
    }
    this.logger.debug(
      `EcoFlow diagnostics: controller received ${message.kind} `
      + `(bytes=${message.payload.length}, generation=${message.generation}, `
      + `activeGeneration=${this.activeGeneration ?? '<none>'})`,
    );
    if (this.activeGeneration !== undefined
      && message.generation < this.activeGeneration) {
      this.logger.debug('EcoFlow diagnostics: controller dropped message from an older connection generation');
      return;
    }
    if (this.activeGeneration === undefined
      || message.generation > this.activeGeneration) {
      this.logger.debug(
        `EcoFlow diagnostics: controller adopting connection generation=${message.generation} and clearing prior-generation state`,
      );
      this.clearCurrentGenerationState();
      this.activeGeneration = message.generation;
    }
    if (message.kind === 'getReply') {
      this.handleQuotaReply(message.payload);
      return;
    }
    const decoded = decodeWave3Message(message.payload);
    if (message.kind === 'property' && decoded.kind === 'display') {
      if (!hasWave3DisplayEvidence(decoded.update)) {
        this.logger.debug(
          `EcoFlow diagnostics: controller rejected display property with no recognized state evidence diagnostic=${JSON.stringify(decoded.diagnostic)}`,
        );
        return;
      }
      if (!isNewerSequence(decoded.sequence, this.lastDisplaySequence)) {
        this.logger.debug(
          `EcoFlow diagnostics: controller rejected display property sequence=${decoded.sequence} `
          + `because lastAcceptedSequence=${this.lastDisplaySequence ?? '<none>'}`,
        );
        return;
      }
      this.lastDisplaySequence = decoded.sequence;
      this.displayState = mergeWave3DisplayUpdate(this.displayState, decoded.update);
      this.displayRevision += 1;
      this.logger.debug(
        `EcoFlow diagnostics: controller accepted display property sequence=${decoded.sequence} update=${JSON.stringify(decoded.update)}`,
      );
      if (this.hasCurrentGenerationState || hasWave3ControlStateEvidence(decoded.update)) {
        this.markStateFresh();
      } else {
        this.logger.debug(
          'EcoFlow diagnostics: controller retained supplemental display telemetry '
          + 'while awaiting authoritative operating-mode state',
        );
        this.updateFreshnessForOnlineSession();
      }
      this.confirmPendingFromObservedState(decoded.update);
      return;
    }
    if (message.kind === 'property' && decoded.kind === 'runtime') {
      if (!isNewerSequence(decoded.sequence, this.lastRuntimeSequence)) {
        this.logger.debug(
          `EcoFlow diagnostics: controller rejected runtime property sequence=${decoded.sequence} `
          + `because lastAcceptedSequence=${this.lastRuntimeSequence ?? '<none>'}`,
        );
        return;
      }
      this.lastRuntimeSequence = decoded.sequence;
      this.runtimeTemperatures = {
        ...this.runtimeTemperatures,
        ...decoded.temperatures,
      };
      this.firmwareVersions = {
        ...this.firmwareVersions,
        ...decoded.firmwareVersions,
      };
      this.logger.debug(
        `EcoFlow diagnostics: controller accepted runtime property sequence=${decoded.sequence} `
        + `temperatures=${JSON.stringify(decoded.temperatures)} `
        + `firmwareVersions=${JSON.stringify(decoded.firmwareVersions)}`,
      );
      this.updateFreshnessForOnlineSession();
      return;
    }
    if (message.kind === 'setReply' && decoded.kind === 'acknowledgement') {
      this.handleAcknowledgement(decoded.sequence, decoded.acknowledgement);
      return;
    }
    this.logger.debug(
      `EcoFlow diagnostics: controller ignored ${message.kind} decoded as ${decoded.kind} diagnostic=${JSON.stringify(decoded.diagnostic)}`,
    );
  }

  private handleQuotaReply(payload: Uint8Array): void {
    const decoded = decodeWave3QuotaReply(payload);
    if (decoded.kind === 'malformed') {
      this.logger.debug(
        `EcoFlow diagnostics: controller rejected malformed latestQuotas reply reason=${JSON.stringify(decoded.reason)}`,
      );
      return;
    }
    this.deviceReportedOnline = decoded.deviceOnline;
    if (!decoded.deviceOnline) {
      this.logger.debug('EcoFlow diagnostics: latestQuotas reports the WAVE 3 offline');
      this.hasCurrentGenerationState = false;
      this.cancelStaleTimer?.();
      this.cancelStaleTimer = undefined;
      this.settlePending('disconnected');
      this.updateSnapshot('offline');
      return;
    }
    if (decoded.update === undefined || !hasWave3DisplayEvidence(decoded.update)) {
      this.logger.debug(
        'EcoFlow diagnostics: latestQuotas reports online but contains no recognized display state evidence',
      );
      this.updateFreshnessForOnlineSession();
      return;
    }
    this.displayState = mergeWave3DisplayUpdate(this.displayState, decoded.update);
    this.displayRevision += 1;
    this.logger.debug(
      `EcoFlow diagnostics: controller accepted latestQuotas update=${JSON.stringify(decoded.update)}`,
    );
    if (this.hasCurrentGenerationState || hasWave3ControlStateEvidence(decoded.update)) {
      this.markStateFresh();
    } else {
      this.logger.debug(
        'EcoFlow diagnostics: controller retained supplemental latestQuotas telemetry '
        + 'while awaiting authoritative operating-mode state',
      );
      this.updateFreshnessForOnlineSession();
    }
    this.confirmPendingFromObservedState(decoded.update);
  }

  private handleAcknowledgement(
    sequence: number,
    acknowledgement: Wave3Acknowledgement,
  ): void {
    const pending = this.pending;
    if (pending === undefined || pending.sequence !== sequence) {
      return;
    }
    const fragment = classifyAcknowledgementFragment(
      acknowledgement,
      pending.command,
    );
    if (fragment === 'unrelated' || fragment === 'conflicting') {
      this.logger.debug(
        `EcoFlow diagnostics: controller ignored same-sequence acknowledgement=${sequence} `
        + `because it is ${fragment} to the pending command; possible foreign client traffic`,
      );
      return;
    }
    if (acknowledgement.reportedConfigOk !== true) {
      pending.acknowledgementRejected = true;
      pending.observedStateConfirmed = false;
      if (pending.publicationCompleted) {
        this.settlePending('acknowledgementRejected');
      }
      return;
    }

    const aggregate = mergeAcknowledgementFragment(
      pending.acknowledgement,
      acknowledgement,
      pending.command,
    );
    pending.acknowledgement = aggregate;
    pending.acknowledgementRevision ??= this.displayRevision;
    const progress = acknowledgementProgress(aggregate, pending.command);
    this.logger.debug(
      `EcoFlow diagnostics: controller command acknowledgement progress sequence=${sequence} `
      + `acknowledgedFields=${JSON.stringify(progress.acknowledgedFields)} `
      + `waitingFields=${JSON.stringify(progress.waitingFields)} `
      + 'waitingForObservedState=true',
    );
    if (pending.publicationCompleted) {
      this.applyAcknowledgement(pending);
    }
  }

  private applyAcknowledgement(pending: PendingCommand): void {
    const acknowledgement = pending.acknowledgement;
    if (acknowledgement === undefined) {
      return;
    }
    if (pending.acknowledgementRejected
      || acknowledgement.reportedConfigOk !== true) {
      this.settlePending('acknowledgementRejected');
      return;
    }
    if (pending.observedStateConfirmed) {
      this.settlePending(undefined);
      return;
    }
    if (pending.stateRefreshRequested) {
      return;
    }
    pending.stateRefreshRequested = true;
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
    this.logger.debug(
      `EcoFlow diagnostics: controller command observed-state confirmation sequence=${pending.sequence} `
      + `command=${describeCommand(pending.command)}`,
    );
    if (pending.publicationCompleted) {
      this.settlePending(undefined);
    }
  }

  private handleSessionState(state: CloudSessionState): void {
    if (this.stopped) {
      return;
    }
    this.logger.debug(`EcoFlow diagnostics: controller observed cloud session state=${state}`);
    if (state === 'offline' || state === 'starting') {
      this.clearCurrentGenerationState();
      if (this.pending?.publicationCompleted !== false) {
        this.settlePending('disconnected');
      }
      this.updateSnapshot('reconnecting');
      return;
    }
    if (state === 'failed') {
      this.clearCurrentGenerationState();
      if (this.pending?.publicationCompleted !== false) {
        this.settlePending('disconnected');
      }
      this.updateSnapshot('accountError');
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
      this.logger.error('EcoFlow diagnostics: controller observed a cloud session failure');
      this.clearCurrentGenerationState();
      this.settlePending('disconnected');
      this.updateSnapshot('accountError');
    }
  }

  private clearCurrentGenerationState(): void {
    this.cancelStaleTimer?.();
    this.cancelStaleTimer = undefined;
    this.hasCurrentGenerationState = false;
    this.deviceReportedOnline = undefined;
    this.displayState = undefined;
    this.runtimeTemperatures = {};
    this.firmwareVersions = {};
    this.updatedAt = undefined;
    this.displayRevision = 0;
    this.lastDisplaySequence = undefined;
    this.lastRuntimeSequence = undefined;
    this.activeGeneration = undefined;
  }

  private markStateFresh(): void {
    this.hasCurrentGenerationState = true;
    this.deviceReportedOnline = true;
    this.updatedAt = this.now();
    this.logger.debug(
      `EcoFlow diagnostics: controller marked state fresh at epochMs=${this.updatedAt}`,
    );
    this.updateFreshnessForOnlineSession();
  }

  private updateFreshnessForOnlineSession(): void {
    this.cancelStaleTimer?.();
    this.cancelStaleTimer = undefined;
    if (this.session.state === 'online' && this.deviceReportedOnline === false) {
      this.updateSnapshot('offline');
      return;
    }
    if (this.session.state !== 'online'
      || !this.hasCurrentGenerationState
      || this.updatedAt === undefined) {
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
    const previousAvailability = this.snapshot.availability;
    this.snapshot = freezeSnapshot({
      availability,
      state: this.displayState?.state ?? {},
      runtimeTemperatures: this.runtimeTemperatures,
      firmwareVersions: this.firmwareVersions,
      updatedAt: this.updatedAt,
    });
    this.logger.debug(
      `EcoFlow diagnostics: controller snapshot availability ${previousAvailability} -> ${availability}; `
      + `state=${JSON.stringify(this.snapshot.state)} `
      + `runtime=${JSON.stringify(this.snapshot.runtimeTemperatures)} `
      + `updatedAt=${this.snapshot.updatedAt ?? '<none>'}`,
    );
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
    this.logger.debug(
      `EcoFlow diagnostics: controller command completed sequence=${pending.sequence} `
      + `outcome=${reason === undefined ? 'confirmed' : `failed:${reason}`} `
      + `command=${describeCommand(pending.command)}`,
    );
    pending.resolve(reason === undefined
      ? { status: 'confirmed', sequence: pending.sequence }
      : { status: 'failed', sequence: pending.sequence, reason });
  }

  private immediateCommandFailure(
    command: Wave3Command,
    sequence: number,
    reason: Wave3CommandFailure,
  ): Wave3CommandResult {
    this.logger.debug(
      `EcoFlow diagnostics: controller command completed sequence=${sequence} `
      + `outcome=failed:${reason} command=${describeCommand(command)}`,
    );
    return { status: 'failed', sequence, reason };
  }

  private takeSequence(): number {
    const sequence = this.nextSequence;
    this.nextSequence = sequence >= 999 ? 10 : sequence + 1;
    return sequence;
  }
}

type AcknowledgementFragmentRelation =
  | 'unrelated'
  | 'conflicting'
  | 'partial'
  | 'complete';

function classifyAcknowledgementFragment(
  acknowledgement: Wave3Acknowledgement,
  command: Wave3Command,
): AcknowledgementFragmentRelation {
  const expected = expectedAcknowledgementValues(command);
  let matchingFields = 0;
  for (const [key, expectedValue] of Object.entries(expected) as Array<
    [keyof Wave3Acknowledgement['values'], boolean | number | string]
  >) {
    const actualValue = acknowledgement.values[key];
    if (actualValue === undefined) {
      continue;
    }
    if (typeof expectedValue === 'number' && typeof actualValue === 'number'
      ? !closeEnough(actualValue, expectedValue)
      : actualValue !== expectedValue) {
      return 'conflicting';
    }
    matchingFields += 1;
  }
  if (matchingFields === 0) {
    return 'unrelated';
  }
  return matchingFields === Object.keys(expected).length ? 'complete' : 'partial';
}

function mergeAcknowledgementFragment(
  previous: Wave3Acknowledgement | undefined,
  incoming: Wave3Acknowledgement,
  command: Wave3Command,
): Wave3Acknowledgement {
  const expected = expectedAcknowledgementValues(command);
  const values = { ...previous?.values };
  for (const key of Object.keys(expected) as Array<keyof typeof values>) {
    const value = incoming.values[key];
    if (value !== undefined) {
      (values as Record<string, boolean | number | string>)[key] = value;
    }
  }
  return {
    reportedConfigOk: true,
    values,
  };
}

function expectedAcknowledgementValues(
  command: Wave3Command,
): Wave3Acknowledgement['values'] {
  switch (command.type) {
  case 'power':
    return command.on ? { mainPower: true } : { systemPaused: true };
  case 'mode':
    return {
      mainPower: true,
      mode: command.mode,
      ...(command.targetTemperatureCelsius === undefined
        ? {}
        : { targetTemperatureCelsius: command.targetTemperatureCelsius }),
      ...(command.targetTemperatureLowerCelsius === undefined
        ? {}
        : { targetTemperatureLowerCelsius: command.targetTemperatureLowerCelsius }),
      ...(command.targetTemperatureUpperCelsius === undefined
        ? {}
        : { targetTemperatureUpperCelsius: command.targetTemperatureUpperCelsius }),
    };
  case 'targetTemperature':
    return { targetTemperatureCelsius: command.celsius };
  case 'automaticTemperatureRange':
    return {
      targetTemperatureLowerCelsius: command.lowerCelsius,
      targetTemperatureUpperCelsius: command.upperCelsius,
    };
  case 'airflowSpeed':
    return { airflowSpeed: command.speed };
  case 'submode':
    return { submode: command.submode };
  }
}

function acknowledgementProgress(
  acknowledgement: Wave3Acknowledgement,
  command: Wave3Command,
): { acknowledgedFields: string[]; waitingFields: string[] } {
  const expectedFields = Object.keys(expectedAcknowledgementValues(command)) as Array<
    keyof Wave3Acknowledgement['values']
  >;
  return {
    acknowledgedFields: expectedFields.filter(
      field => acknowledgement.values[field] !== undefined,
    ),
    waitingFields: expectedFields.filter(
      field => acknowledgement.values[field] === undefined,
    ),
  };
}

function describeCommand(command: Wave3Command): string {
  // WAVE commands contain only bounded mode, setpoint, fan, submode, and power
  // values. Device/account identifiers and encoded payload bytes never enter
  // this diagnostic representation.
  return JSON.stringify(command);
}

function stateMatchesCommand(state: Wave3State, command: Wave3Command): boolean {
  switch (command.type) {
  case 'power':
    return state.powered === command.on;
  case 'mode':
    return state.powered === true
      && state.mode === command.mode
      && optionalCloseEnough(
        state.targetTemperatureCelsius,
        command.targetTemperatureCelsius,
      )
      && optionalCloseEnough(
        state.targetTemperatureLowerCelsius,
        command.targetTemperatureLowerCelsius,
      )
      && optionalCloseEnough(
        state.targetTemperatureUpperCelsius,
        command.targetTemperatureUpperCelsius,
      );
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
    return update.operatingModeId !== undefined
      && (command.targetTemperatureCelsius === undefined
        || parameters?.targetTemperatureCelsius !== undefined)
      && (command.targetTemperatureLowerCelsius === undefined
        || parameters?.targetTemperatureLowerCelsius !== undefined)
      && (command.targetTemperatureUpperCelsius === undefined
        || parameters?.targetTemperatureUpperCelsius !== undefined);
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

function optionalCloseEnough(
  actual: number | undefined,
  expected: number | undefined,
): boolean {
  return expected === undefined || closeEnough(actual, expected);
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
    return 'accountError';
  case 'idle':
    return 'offline';
  case 'stopped':
    return 'stopped';
  }
}

function freezeSnapshot(
  snapshot: Omit<Wave3ControllerSnapshot, 'state' | 'runtimeTemperatures' | 'firmwareVersions'> & {
    state: Wave3State;
    runtimeTemperatures: Wave3RuntimeTemperatures;
    firmwareVersions: Wave3FirmwareVersions;
  },
): Wave3ControllerSnapshot {
  return Object.freeze({
    ...snapshot,
    state: Object.freeze({ ...snapshot.state }),
    runtimeTemperatures: Object.freeze({ ...snapshot.runtimeTemperatures }),
    firmwareVersions: Object.freeze({ ...snapshot.firmwareVersions }),
  });
}

function defaultSchedule(callback: () => void, delayMilliseconds: number): () => void {
  const timer = setTimeout(callback, delayMilliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}
