import { randomInt } from 'node:crypto';

import {
  encodeWave3Command,
  hasWave3ControlStateEvidence,
  hasWave3DisplayEvidence,
  mergeWave3DisplayUpdate,
  type DecodedWave3QuotaReply,
} from './codec.js';
import {
  WAVE3_MODE_IDS,
  type Wave3AcknowledgedValues,
  type Wave3Acknowledgement,
  type Wave3Command,
  type Wave3CommandFailure,
  type Wave3CommandResult,
  type Wave3ControllerSnapshot,
  type Wave3DisplayState,
  type Wave3DisplayUpdate,
  type Wave3FirmwareVersions,
  type Wave3ModeParameters,
  type Wave3ModeProfiles,
  type Wave3RuntimeTemperatures,
  type Wave3State,
} from './domain.js';
import type {
  CloudSessionLogger,
  CloudSessionState,
  Wave3ControllerSession,
  Wave3InboundEvent,
} from './sessionPort.js';

export type { Wave3ControllerSession } from './sessionPort.js';

export interface Wave3AccessoryController {
  readonly snapshot: Wave3ControllerSnapshot;
  onSnapshot(listener: (snapshot: Wave3ControllerSnapshot) => void): () => void;
  execute(command: Wave3Command): Promise<Wave3CommandResult>;
  stop(): void;
}

export interface Wave3ControllerOptions {
  commandTimeoutMilliseconds?: number;
  sequenceRebaseTimeoutMilliseconds?: number;
  staleAfterMilliseconds?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMilliseconds: number) => () => void;
  initialSequence?: number;
  logger?: CloudSessionLogger;
}

interface PendingCommand {
  command: Wave3Command;
  sequence: number;
  baselineEvidenceFields: ReadonlySet<CommandEvidenceField>;
  observedEvidenceFields: Set<CommandEvidenceField>;
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

interface PendingSequenceRebase {
  previousSequence: number;
  firstCandidateSequence: number;
  lastCandidateSequence: number;
  controlEvidenceObserved: boolean;
  refreshRequested: boolean;
  cancelTimeout: () => void;
}

const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_SEQUENCE_REBASE_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_STALE_AFTER_MILLISECONDS = 300_000;
const MINIMUM_RUNTIME_FRESHNESS_MILLISECONDS = 11 * 60_000;
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
  private environmentUpdatedAt?: number;
  private profilesUpdatedAt?: number;
  private acPowerUpdatedAt?: number;
  private runtimeTemperaturesUpdatedAt?: number;
  private displayRevision = 0;
  private lastDisplaySequence?: number;
  private lastRuntimeSequence?: number;
  private sequenceRebase?: PendingSequenceRebase;
  private activeGeneration?: number;
  private nextSequence: number;
  private stopped = false;
  private hasCurrentGenerationState = false;
  private deviceReportedOnline?: boolean;

  public snapshot: Wave3ControllerSnapshot;

  private readonly commandTimeoutMilliseconds: number;
  private readonly sequenceRebaseTimeoutMilliseconds: number;
  private readonly staleAfterMilliseconds: number;
  private readonly runtimeFreshnessAfterMilliseconds: number;
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
    this.sequenceRebaseTimeoutMilliseconds = options.sequenceRebaseTimeoutMilliseconds
      ?? DEFAULT_SEQUENCE_REBASE_TIMEOUT_MILLISECONDS;
    this.staleAfterMilliseconds = options.staleAfterMilliseconds
      ?? DEFAULT_STALE_AFTER_MILLISECONDS;
    this.runtimeFreshnessAfterMilliseconds = Math.max(
      this.staleAfterMilliseconds,
      MINIMUM_RUNTIME_FRESHNESS_MILLISECONDS,
    );
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.schedule = options.schedule ?? defaultSchedule;
    this.nextSequence = options.initialSequence ?? randomInt(10, 1_000);
    this.snapshot = freezeSnapshot({
      availability: availabilityForSession(session.state, false),
      environmentTelemetryFresh: false,
      state: {},
      modeProfiles: {},
      runtimeTemperatures: {},
      runtimeTemperaturesFresh: false,
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
    this.clearSequenceRebase();
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
        baselineEvidenceFields: matchingDisplayStateFields(this.displayState, command),
        observedEvidenceFields: new Set(),
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

  private handleMessage(event: Wave3InboundEvent): void {
    if (this.stopped || event.serialNumber !== this.serialNumber) {
      return;
    }
    this.logger.debug(
      `EcoFlow diagnostics: controller received ${event.kind} `
      + `(bytes=${event.payloadLength}, generation=${event.generation}, `
      + `activeGeneration=${this.activeGeneration ?? '<none>'})`,
    );
    if (this.activeGeneration !== undefined
      && event.generation < this.activeGeneration) {
      this.logger.debug('EcoFlow diagnostics: controller dropped message from an older connection generation');
      return;
    }
    if (this.activeGeneration === undefined
      || event.generation > this.activeGeneration) {
      this.logger.debug(
        `EcoFlow diagnostics: controller adopting connection generation=${event.generation} and clearing prior-generation state`,
      );
      this.clearCurrentGenerationState();
      this.activeGeneration = event.generation;
    }
    if (event.kind === 'getReply') {
      this.handleQuotaReply(event.decoded);
      return;
    }
    const decoded = event.decoded;
    if (event.kind === 'property' && decoded.kind === 'display') {
      if (!hasWave3DisplayEvidence(decoded.update)) {
        this.logger.debug(
          `EcoFlow diagnostics: controller rejected display property with no recognized state evidence diagnostic=${JSON.stringify(decoded.diagnostic)}`,
        );
        return;
      }
      if (!isNewerSequence(decoded.sequence, this.lastDisplaySequence)) {
        if (this.considerSequenceRebase(decoded.sequence, decoded.update)) {
          return;
        }
        this.logger.debug(
          `EcoFlow diagnostics: controller rejected display property sequence=${decoded.sequence} `
          + `because lastAcceptedSequence=${this.lastDisplaySequence ?? '<none>'}`,
        );
        return;
      }
      this.clearSequenceRebase();
      this.lastDisplaySequence = decoded.sequence;
      this.displayState = mergeWave3DisplayUpdate(this.displayState, decoded.update);
      this.recordDisplayFreshness(decoded.update);
      this.displayRevision += 1;
      this.logger.debug(
        `EcoFlow diagnostics: controller accepted display property sequence=${decoded.sequence} update=${JSON.stringify(decoded.update)}`,
      );
      if (hasWave3ControlStateEvidence(decoded.update)) {
        this.markStateFresh();
      } else {
        this.logger.debug(
          'EcoFlow diagnostics: controller retained supplemental display telemetry '
          + 'without renewing operational control authority',
        );
        this.updateFreshnessForOnlineSession();
      }
      this.confirmPendingFromObservedState(decoded.update);
      return;
    }
    if (event.kind === 'property' && decoded.kind === 'runtime') {
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
      if (Object.keys(decoded.temperatures).length > 0) {
        this.runtimeTemperaturesUpdatedAt = this.now();
      }
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
    if (event.kind === 'setReply' && decoded.kind === 'acknowledgement') {
      this.handleAcknowledgement(decoded.sequence, decoded.acknowledgement);
      return;
    }
    this.logger.debug(
      `EcoFlow diagnostics: controller ignored ${event.kind} decoded as ${decoded.kind} diagnostic=${JSON.stringify(decoded.diagnostic)}`,
    );
  }

  private handleQuotaReply(decoded: DecodedWave3QuotaReply): void {
    if (decoded.kind === 'malformed') {
      this.logger.debug(
        `EcoFlow diagnostics: controller rejected malformed latestQuotas reply reason=${JSON.stringify(decoded.reason)}`,
      );
      return;
    }
    this.deviceReportedOnline = decoded.deviceOnline;
    if (!decoded.deviceOnline) {
      this.clearSequenceRebase();
      this.logger.debug('EcoFlow diagnostics: latestQuotas reports the WAVE 3 offline');
      this.hasCurrentGenerationState = false;
      this.clearAcPowerMeasurement();
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
    if (this.sequenceRebase?.refreshRequested === true
      && hasWave3ControlStateEvidence(decoded.update)) {
      const rebasedSequence = this.sequenceRebase.lastCandidateSequence;
      this.clearSequenceRebase();
      this.lastDisplaySequence = rebasedSequence;
      this.lastRuntimeSequence = undefined;
      this.logger.debug(
        'EcoFlow diagnostics: authoritative online state confirmed; sequence baselines rebased '
        + `(displaySequence=${rebasedSequence})`,
      );
    }
    this.displayState = mergeWave3DisplayUpdate(this.displayState, decoded.update);
    this.recordDisplayFreshness(decoded.update);
    this.displayRevision += 1;
    this.logger.debug(
      `EcoFlow diagnostics: controller accepted latestQuotas update=${JSON.stringify(decoded.update)}`,
    );
    if (hasWave3ControlStateEvidence(decoded.update)) {
      this.markStateFresh();
    } else {
      this.logger.debug(
        'EcoFlow diagnostics: controller retained supplemental latestQuotas telemetry '
        + 'without renewing operational control authority',
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
    this.evaluatePendingConfirmation(pending);
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
      || this.displayRevision <= pending.acknowledgementRevision) {
      return;
    }
    for (const field of matchingObservedUpdateFields(
      update,
      this.displayState,
      pending.command,
    )) {
      pending.observedEvidenceFields.add(field);
    }
    this.evaluatePendingConfirmation(pending);
  }

  private evaluatePendingConfirmation(pending: PendingCommand): void {
    const acknowledgement = pending.acknowledgement;
    if (acknowledgement === undefined
      || pending.observedEvidenceFields.size === 0
      || !allCommandFieldsHaveEvidence(pending, acknowledgement)
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
    this.environmentUpdatedAt = undefined;
    this.profilesUpdatedAt = undefined;
    this.acPowerUpdatedAt = undefined;
    this.runtimeTemperaturesUpdatedAt = undefined;
    this.displayRevision = 0;
    this.lastDisplaySequence = undefined;
    this.lastRuntimeSequence = undefined;
    this.clearSequenceRebase();
    this.activeGeneration = undefined;
  }

  private considerSequenceRebase(
    candidateSequence: number,
    update: Wave3DisplayUpdate,
  ): boolean {
    const previousSequence = this.lastDisplaySequence;
    if (previousSequence === undefined || candidateSequence === previousSequence) {
      return false;
    }

    // A reset candidate may arrive as the WAVE's normal split startup burst:
    // sleep state, temperatures, and active mode are separate packets. Either
    // active-mode fragment is sufficient here because the correlated quota
    // reply, not this packet, is what authorizes the eventual rebase.
    const controlEvidence = hasSequenceEpochControlEvidence(update);
    const pending = this.sequenceRebase;
    if (pending === undefined
      || pending.previousSequence !== previousSequence
      || !isNewerSequence(candidateSequence, pending.lastCandidateSequence)) {
      this.clearSequenceRebase();
      this.sequenceRebase = this.createSequenceRebaseCandidate(
        previousSequence,
        candidateSequence,
        controlEvidence,
      );
      this.logger.debug(
        'EcoFlow diagnostics: suspected device sequence epoch change '
        + `(previous=${previousSequence}, candidate=${candidateSequence}); awaiting corroboration`,
      );
      return true;
    }

    pending.lastCandidateSequence = candidateSequence;
    pending.controlEvidenceObserved ||= controlEvidence;
    if (!pending.controlEvidenceObserved || pending.refreshRequested) {
      return true;
    }

    pending.refreshRequested = true;
    this.resetSequenceRebaseTimeout(pending);
    this.logger.debug(
      'EcoFlow diagnostics: corroborated device sequence epoch change '
      + `(previous=${previousSequence}, firstCandidate=${pending.firstCandidateSequence}, `
      + `latestCandidate=${candidateSequence}); requesting authoritative state before sequence rebase`,
    );
    void this.session.requestState(this.serialNumber).catch(() => {
      if (this.sequenceRebase === pending) {
        this.logger.warn(
          'EcoFlow diagnostics: sequence rebase state request failed; remaining on the prior sequence epoch',
        );
        this.clearSequenceRebase();
      }
    });
    return true;
  }

  private createSequenceRebaseCandidate(
    previousSequence: number,
    candidateSequence: number,
    controlEvidenceObserved: boolean,
  ): PendingSequenceRebase {
    const pending: PendingSequenceRebase = {
      previousSequence,
      firstCandidateSequence: candidateSequence,
      lastCandidateSequence: candidateSequence,
      controlEvidenceObserved,
      refreshRequested: false,
      cancelTimeout: () => undefined,
    };
    this.resetSequenceRebaseTimeout(pending);
    return pending;
  }

  private resetSequenceRebaseTimeout(pending: PendingSequenceRebase): void {
    pending.cancelTimeout();
    pending.cancelTimeout = this.schedule(() => {
      if (this.sequenceRebase === pending) {
        this.logger.debug(
          'EcoFlow diagnostics: sequence rebase evidence expired without authoritative confirmation',
        );
        this.sequenceRebase = undefined;
      }
    }, this.sequenceRebaseTimeoutMilliseconds);
  }

  private clearSequenceRebase(): void {
    this.sequenceRebase?.cancelTimeout();
    this.sequenceRebase = undefined;
  }

  private markStateFresh(): void {
    this.hasCurrentGenerationState = true;
    this.deviceReportedOnline = true;
    this.updatedAt = this.now();
    this.logger.debug(
      `EcoFlow diagnostics: controller marked operational control authority fresh at epochMs=${this.updatedAt}`,
    );
    this.updateFreshnessForOnlineSession();
  }

  private updateFreshnessForOnlineSession(): void {
    this.cancelStaleTimer?.();
    this.cancelStaleTimer = undefined;
    const now = this.now();
    this.expireSupplementalKnowledge(now);
    if (this.session.state === 'online' && this.deviceReportedOnline === false) {
      this.updateSnapshot('offline');
      return;
    }
    if (this.session.state !== 'online'
      || !this.hasCurrentGenerationState
      || this.updatedAt === undefined) {
      if (this.session.state === 'online') {
        this.scheduleNextFreshnessExpiry(now, []);
      }
      this.updateSnapshot(this.session.state === 'online' ? 'stale' : 'reconnecting');
      return;
    }
    const operationalRemaining = this.staleAfterMilliseconds - (now - this.updatedAt);
    const availability = operationalRemaining <= 0 ? 'stale' : 'online';
    this.scheduleNextFreshnessExpiry(
      now,
      operationalRemaining <= 0 ? [] : [operationalRemaining],
    );
    this.updateSnapshot(availability);
  }

  private updateSnapshot(availability: Wave3ControllerSnapshot['availability']): void {
    const previousAvailability = this.snapshot.availability;
    this.snapshot = freezeSnapshot({
      availability,
      ...(this.displayState?.acPowerWatts === undefined
        ? {}
        : { acPowerWatts: this.displayState.acPowerWatts }),
      environmentTelemetryFresh: this.environmentUpdatedAt !== undefined,
      state: this.displayState?.state ?? {},
      modeProfiles: modeProfilesForDisplayState(this.displayState),
      runtimeTemperatures: this.runtimeTemperatures,
      runtimeTemperaturesFresh: this.runtimeTemperaturesUpdatedAt !== undefined
        && !isExpired(
          this.runtimeTemperaturesUpdatedAt,
          this.now(),
          this.runtimeFreshnessAfterMilliseconds,
        ),
      runtimeTemperaturesObservedAt: this.runtimeTemperaturesUpdatedAt,
      firmwareVersions: this.firmwareVersions,
      updatedAt: this.updatedAt,
    });
    this.logger.debug(
      `EcoFlow diagnostics: controller snapshot availability ${previousAvailability} -> ${availability}; `
      + `state=${JSON.stringify(this.snapshot.state)} `
      + `runtime=${JSON.stringify(this.snapshot.runtimeTemperatures)} `
      + `runtimeFresh=${this.snapshot.runtimeTemperaturesFresh} `
      + `runtimeObservedAt=${this.snapshot.runtimeTemperaturesObservedAt ?? '<none>'} `
      + `updatedAt=${this.snapshot.updatedAt ?? '<none>'}`,
    );
    for (const listener of this.snapshotListeners) {
      listener(this.snapshot);
    }
  }

  private recordDisplayFreshness(update: Wave3DisplayUpdate): void {
    const observedAt = this.now();
    if (update.ambientTemperatureCelsius !== undefined
      || update.ambientHumidityPercent !== undefined
      || update.outletTemperatureCelsius !== undefined) {
      this.environmentUpdatedAt = observedAt;
    }
    if (Object.keys(update.modeParameters).length > 0) {
      this.profilesUpdatedAt = observedAt;
    }
    if (update.acPowerWatts !== undefined) {
      this.acPowerUpdatedAt = observedAt;
    }
  }

  private supplementalFreshnessRemainingTimes(now: number): number[] {
    return [
      ...[this.environmentUpdatedAt, this.profilesUpdatedAt, this.acPowerUpdatedAt]
        .filter((value): value is number => value !== undefined)
        .map(timestamp => this.staleAfterMilliseconds - (now - timestamp)),
      ...(this.runtimeTemperaturesUpdatedAt === undefined
        ? []
        : [
          this.runtimeFreshnessAfterMilliseconds
            - (now - this.runtimeTemperaturesUpdatedAt),
        ]),
    ].filter(remaining => remaining > 0);
  }

  private scheduleNextFreshnessExpiry(now: number, additionalRemaining: number[]): void {
    const remainingTimes = [
      ...additionalRemaining,
      ...this.supplementalFreshnessRemainingTimes(now),
    ];
    const nextExpiry = remainingTimes.length === 0 ? undefined : Math.min(...remainingTimes);
    if (nextExpiry === undefined) {
      return;
    }
    this.cancelStaleTimer = this.schedule(() => {
      if (!this.stopped && this.session.state === 'online') {
        this.updateFreshnessForOnlineSession();
      }
    }, nextExpiry);
  }

  private expireSupplementalKnowledge(now: number): void {
    if (isExpired(this.environmentUpdatedAt, now, this.staleAfterMilliseconds)) {
      this.environmentUpdatedAt = undefined;
      if (this.displayState !== undefined) {
        const state = { ...this.displayState.state };
        delete state.ambientHumidityPercent;
        delete state.ambientTemperatureCelsius;
        delete state.outletTemperatureCelsius;
        this.displayState = { ...this.displayState, state };
      }
    }
    if (isExpired(this.profilesUpdatedAt, now, this.staleAfterMilliseconds)) {
      this.profilesUpdatedAt = undefined;
      if (this.displayState !== undefined) {
        const state = { ...this.displayState.state };
        delete state.airflowSpeed;
        delete state.submode;
        delete state.targetTemperatureCelsius;
        delete state.targetTemperatureLowerCelsius;
        delete state.targetTemperatureUpperCelsius;
        this.displayState = { ...this.displayState, modeParameters: {}, state };
      }
    }
    if (isExpired(this.acPowerUpdatedAt, now, this.staleAfterMilliseconds)) {
      this.clearAcPowerMeasurement();
    }
  }

  private clearAcPowerMeasurement(): void {
    this.acPowerUpdatedAt = undefined;
    if (this.displayState !== undefined) {
      const displayState = { ...this.displayState };
      delete displayState.acPowerWatts;
      this.displayState = displayState;
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
      + `outcome=${commandOutcome(reason)} `
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
      + `outcome=${commandOutcome(reason)} command=${describeCommand(command)}`,
    );
    return { status: 'failed', sequence, reason };
  }

  private takeSequence(): number {
    const sequence = this.nextSequence;
    this.nextSequence = sequence >= 999 ? 10 : sequence + 1;
    return sequence;
  }
}

function commandOutcome(reason: Wave3CommandFailure | undefined): string {
  if (reason === undefined) {
    return 'confirmed';
  }
  return reason === 'timeout' ? 'unconfirmed:timeout' : `failed:${reason}`;
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
  case 'temperatureDisplayUnit':
    return { temperatureDisplayUnit: command.unit };
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

type CommandEvidenceField = keyof Wave3AcknowledgedValues;

function allCommandFieldsHaveEvidence(
  pending: PendingCommand,
  acknowledgement: Wave3Acknowledgement,
): boolean {
  const acknowledgedFields = new Set(
    acknowledgementProgress(acknowledgement, pending.command).acknowledgedFields,
  );
  return (Object.keys(expectedAcknowledgementValues(pending.command)) as CommandEvidenceField[])
    .every(field => acknowledgedFields.has(field)
      || pending.baselineEvidenceFields.has(field)
      || pending.observedEvidenceFields.has(field));
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
  case 'temperatureDisplayUnit':
    return state.temperatureDisplayUnit === command.unit;
  }
}

function matchingDisplayStateFields(
  displayState: Wave3DisplayState | undefined,
  command: Wave3Command,
): ReadonlySet<CommandEvidenceField> {
  const matching = new Set<CommandEvidenceField>();
  if (displayState === undefined) {
    return matching;
  }
  for (const [field, expected] of Object.entries(
    expectedAcknowledgementValues(command),
  ) as Array<[CommandEvidenceField, boolean | number | string]>) {
    if (displayFieldMatchesExpected(displayState, field, expected)) {
      matching.add(field);
    }
  }
  return matching;
}

function matchingObservedUpdateFields(
  update: Wave3DisplayUpdate,
  displayState: Wave3DisplayState | undefined,
  command: Wave3Command,
): ReadonlySet<CommandEvidenceField> {
  const matching = new Set<CommandEvidenceField>();
  if (displayState === undefined) {
    return matching;
  }
  const activeModeId = command.type === 'mode'
    ? WAVE3_MODE_IDS[command.mode]
    : displayState.operatingModeId;
  const parameters = activeModeId === undefined
    ? undefined
    : update.modeParameters[activeModeId];
  const evidencedFields = new Set<CommandEvidenceField>();
  if (update.sleepState === 0
    || (update.operatingModeId !== undefined && update.operatingModeId !== 0)) {
    evidencedFields.add('mainPower');
  }
  if (update.sleepState === 1 || update.operatingModeId === 0) {
    evidencedFields.add('systemPaused');
  }
  if (update.operatingModeId !== undefined || update.sleepState === 0) {
    evidencedFields.add('mode');
  }
  if (parameters?.targetTemperatureCelsius !== undefined) {
    evidencedFields.add('targetTemperatureCelsius');
  }
  if (parameters?.targetTemperatureLowerCelsius !== undefined) {
    evidencedFields.add('targetTemperatureLowerCelsius');
  }
  if (parameters?.targetTemperatureUpperCelsius !== undefined) {
    evidencedFields.add('targetTemperatureUpperCelsius');
  }
  if (parameters?.airflowSpeed !== undefined) {
    evidencedFields.add('airflowSpeed');
  }
  if (parameters?.submode !== undefined) {
    evidencedFields.add('submode');
  }
  if (update.temperatureDisplayUnit !== undefined) {
    evidencedFields.add('temperatureDisplayUnit');
  }
  for (const [field, expected] of Object.entries(
    expectedAcknowledgementValues(command),
  ) as Array<[CommandEvidenceField, boolean | number | string]>) {
    if (evidencedFields.has(field)
      && displayFieldMatchesExpected(displayState, field, expected)) {
      matching.add(field);
    }
  }
  return matching;
}

function displayFieldMatchesExpected(
  displayState: Wave3DisplayState,
  field: CommandEvidenceField,
  expected: boolean | number | string,
): boolean {
  switch (field) {
  case 'mainPower':
    return displayState.state.powered === expected;
  case 'systemPaused':
    return expected === true && displayState.state.powered === false;
  case 'mode':
    return typeof expected === 'string'
      && displayState.operatingModeId === WAVE3_MODE_IDS[expected as keyof typeof WAVE3_MODE_IDS];
  case 'targetTemperatureCelsius':
    return typeof expected === 'number'
      && closeEnough(displayState.state.targetTemperatureCelsius, expected);
  case 'targetTemperatureLowerCelsius':
    return typeof expected === 'number'
      && closeEnough(displayState.state.targetTemperatureLowerCelsius, expected);
  case 'targetTemperatureUpperCelsius':
    return typeof expected === 'number'
      && closeEnough(displayState.state.targetTemperatureUpperCelsius, expected);
  case 'airflowSpeed':
    return displayState.state.airflowSpeed === expected;
  case 'submode':
    return displayState.state.submode === expected;
  case 'temperatureDisplayUnit':
    return displayState.state.temperatureDisplayUnit === expected;
  }
}

function closeEnough(actual: number | undefined, expected: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) < 0.01;
}

function isExpired(
  updatedAt: number | undefined,
  now: number,
  freshnessTimeoutMilliseconds: number,
): boolean {
  return updatedAt !== undefined && now - updatedAt >= freshnessTimeoutMilliseconds;
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

function hasSequenceEpochControlEvidence(update: Wave3DisplayUpdate): boolean {
  return update.sleepState !== undefined || update.operatingModeId !== undefined;
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
  snapshot: Omit<
    Wave3ControllerSnapshot,
    'state' | 'modeProfiles' | 'runtimeTemperatures' | 'firmwareVersions'
  > & {
    state: Wave3State;
    modeProfiles: Partial<Record<Exclude<keyof typeof WAVE3_MODE_IDS, 'off'>, Wave3ModeParameters>>;
    runtimeTemperatures: Wave3RuntimeTemperatures;
    firmwareVersions: Wave3FirmwareVersions;
  },
): Wave3ControllerSnapshot {
  const modeProfiles = Object.fromEntries(
    Object.entries(snapshot.modeProfiles).map(([mode, profile]) => [
      mode,
      Object.freeze({ ...profile }),
    ]),
  ) as Wave3ModeProfiles;
  return Object.freeze({
    ...snapshot,
    state: Object.freeze({ ...snapshot.state }),
    modeProfiles: Object.freeze(modeProfiles),
    runtimeTemperatures: Object.freeze({ ...snapshot.runtimeTemperatures }),
    firmwareVersions: Object.freeze({ ...snapshot.firmwareVersions }),
  });
}

function modeProfilesForDisplayState(
  displayState: Wave3DisplayState | undefined,
): Partial<Record<Exclude<keyof typeof WAVE3_MODE_IDS, 'off'>, Wave3ModeParameters>> {
  if (displayState === undefined) {
    return {};
  }
  const profiles: Partial<Record<
    Exclude<keyof typeof WAVE3_MODE_IDS, 'off'>,
    Wave3ModeParameters
  >> = {};
  for (const mode of ['cool', 'heat', 'fan', 'dry', 'auto'] as const) {
    const profile = displayState.modeParameters[WAVE3_MODE_IDS[mode]];
    if (profile !== undefined) {
      profiles[mode] = profile;
    }
  }
  return profiles;
}

function defaultSchedule(callback: () => void, delayMilliseconds: number): () => void {
  const timer = setTimeout(callback, delayMilliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}
