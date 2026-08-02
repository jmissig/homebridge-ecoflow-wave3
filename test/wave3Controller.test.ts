import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { create, toBinary } from '@bufbuild/protobuf';

import {
  EcoFlowCloudSessionError,
  type CloudSessionState,
  type Wave3InboundMessage,
} from '../src/ecoflow/session.js';
import {
  Wave3ConfigWriteAckSchema,
  Wave3DisplayPropertyUploadSchema,
  Wave3RuntimePropertyUploadSchema,
  Wave3SetMessageSchema,
} from '../src/proto/gen/ecoflow/wave3/v1/wave3_pb.js';
import {
  Wave3Controller,
  type Wave3ControllerSession,
} from '../src/wave3/controller.js';
import type { Wave3Command } from '../src/wave3/domain.js';

const TEST_SERIAL = 'TESTWAVE30001';

describe('WAVE 3 controller', () => {
  it('merges partial state immutably, rejects out-of-order telemetry, and becomes stale', () => {
    const session = new FakeControllerSession();
    const clock = new FakeClock();
    const controller = new Wave3Controller(TEST_SERIAL, session, {
      now: () => clock.now,
      schedule: clock.schedule,
      staleAfterMilliseconds: 100,
    });
    assert.equal(controller.snapshot.availability, 'stale');

    session.emitPacket('property', displayPacket(20, {
      mode: 1,
      sleepState: 0,
      ambientTemperature: 24,
      targetTemperature: 21,
      airflowSpeed: 60,
    }));
    const firstSnapshot = controller.snapshot;
    assert.deepEqual(firstSnapshot.state, {
      sleeping: false,
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 24,
      targetTemperatureCelsius: 21,
      airflowSpeed: 60,
    });
    assert.equal(Object.isFrozen(firstSnapshot), true);
    assert.equal(Object.isFrozen(firstSnapshot.state), true);

    clock.now = 10;
    session.emitPacket('property', displayPacket(21, {
      modeParametersOnly: true,
      mode: 1,
      targetTemperature: 22,
    }));
    assert.equal(controller.snapshot.state.targetTemperatureCelsius, 22);
    assert.equal(controller.snapshot.state.airflowSpeed, 60);
    assert.equal(firstSnapshot.state.targetTemperatureCelsius, 21);

    session.emitPacket('property', displayPacket(19, {
      mode: 2,
      targetTemperature: 27,
    }));
    assert.equal(controller.snapshot.state.mode, 'cool');
    assert.equal(controller.snapshot.state.targetTemperatureCelsius, 22);

    clock.advance(100);
    assert.equal(controller.snapshot.availability, 'stale');

    session.emitState('offline');
    assert.equal(controller.snapshot.availability, 'reconnecting');
    session.emitState('online');
    assert.equal(controller.snapshot.availability, 'stale');
    session.emitPacket('property', displayPacket(1, { mode: 2, sleepState: 0 }));
    assert.equal(controller.snapshot.state.mode, 'heat');

    session.emitPacket('property', runtimePacket(5, {
      indoorReturnAir: 23,
      pdFirmware: 16_842_856,
    }));
    session.emitPacket('property', runtimePacket(6, {
      condenser: 41,
      bmsFirmware: 16_777_217,
    }));
    assert.deepEqual(controller.snapshot.runtimeTemperatures, {
      indoorReturnAirCelsius: 23,
      condenserCelsius: 41,
    });
    assert.deepEqual(controller.snapshot.firmwareVersions, {
      pd: '1.1.0.104',
      bms: '1.0.0.1',
    });
    session.emitPacket('property', runtimePacket(4, {
      condenser: 99,
    }));
    assert.equal(controller.snapshot.runtimeTemperatures.condenserCelsius, 41);
  });

  it('requires current-generation climate evidence and honors quota availability', async () => {
    const session = new FakeControllerSession();
    const controller = new Wave3Controller(TEST_SERIAL, session, {
      initialSequence: 10,
    });
    assert.equal(controller.snapshot.availability, 'stale');

    session.emitPacket('getReply', quotaReply({
      online: 1,
      quotaMap: {
        dev_sleep_state: 0,
        wave_operating_mode: 1,
        temp_ambient: 24,
        current_temp_set: 22,
        current_airflow_speed: 60,
      },
    }));
    assert.equal(controller.snapshot.availability, 'online');
    assert.deepEqual(controller.snapshot.state, {
      sleeping: false,
      powered: true,
      mode: 'cool',
      ambientTemperatureCelsius: 24,
      targetTemperatureCelsius: 22,
      airflowSpeed: 60,
    });

    session.emitState('offline');
    session.emitState('online');
    assert.equal(controller.snapshot.availability, 'stale');
    session.emitPacket('property', runtimePacket(1, { condenser: 40 }));
    assert.equal(controller.snapshot.availability, 'stale');
    session.emitPacket('getReply', new TextEncoder().encode('{broken'));
    assert.equal(controller.snapshot.availability, 'stale');
    assert.deepEqual(
      await controller.execute({ type: 'power', on: false }),
      { status: 'failed', sequence: 10, reason: 'disconnected' },
    );

    session.emitPacket('property', displayPacket(2, { ambientTemperature: 25 }));
    assert.equal(controller.snapshot.availability, 'stale');
    assert.deepEqual(controller.snapshot.state, {
      ambientTemperatureCelsius: 25,
    });

    session.emitPacket('property', displayPacket(3, { mode: 1 }));
    assert.equal(controller.snapshot.availability, 'stale');
    session.emitPacket('property', displayPacket(4, { mode: 1, sleepState: 0 }));
    assert.equal(controller.snapshot.availability, 'online');
    assert.equal(controller.snapshot.state.mode, 'cool');

    session.emitState('offline');
    session.emitState('online');
    session.emitPacket('property', envelope(99, 4, Uint8Array.of(1, 2, 3)));
    assert.equal(controller.snapshot.availability, 'stale');
    assert.deepEqual(controller.snapshot.state, {});

    session.emitPacket('property', displayPacket(5, { mode: 99 }));
    assert.equal(controller.snapshot.availability, 'stale');
    assert.deepEqual(controller.snapshot.state, {});

    session.emitPacket('getReply', quotaReply({ online: 0 }));
    assert.equal(controller.snapshot.availability, 'offline');

    session.emitPacket('getReply', quotaReply({
      online: true,
      quotaMap: {
        dev_sleep_state: 0,
        wave_operating_mode: 2,
        current_temp_set: 23,
      },
    }));
    assert.equal(controller.snapshot.availability, 'online');
    assert.equal(controller.snapshot.state.mode, 'heat');
    assert.equal(controller.snapshot.state.targetTemperatureCelsius, 23);
  });

  it('requires a matching positive acknowledgement and later observed state', async () => {
    const session = new FakeControllerSession();
    const clock = new FakeClock();
    const controller = readyController(session, {
      schedule: clock.schedule,
      initialSequence: 40,
    });

    let settled = false;
    const result = controller.execute({ type: 'mode', mode: 'heat' }).then(value => {
      settled = true;
      return value;
    });
    await flushAsyncWork();
    assert.equal(session.publishCalls.length, 1);
    assert.equal(controller.snapshot.state.mode, 'cool');

    session.emitPacket('property', displayPacket(100, { mode: 2 }));
    session.emitPacket('setReply', acknowledgementPacket(41, {
      configOk: true,
      mainPower: true,
      mode: 2,
    }));
    await flushAsyncWork();
    assert.equal(settled, false);

    session.emitPacket('setReply', acknowledgementPacket(40, {
      configOk: true,
      mainPower: true,
      mode: 2,
    }));
    await flushAsyncWork();
    assert.equal(session.requestStateCalls, 1);
    assert.equal(settled, false);

    session.emitPacket('property', displayPacket(100, { mode: 2 }));
    await flushAsyncWork();
    assert.equal(settled, false);
    session.emitPacket('property', displayPacket(101, { mode: 2 }));

    assert.deepEqual(await result, { status: 'confirmed', sequence: 40 });
    assert.equal(controller.snapshot.state.mode, 'heat');
  });

  it('cannot confirm before publication succeeds', async () => {
    const session = new FakeControllerSession();
    const publicationGate = new Deferred<void>();
    session.publishGate = publicationGate;
    const controller = readyController(session, {
      initialSequence: 45,
    });
    const result = controller.execute({ type: 'mode', mode: 'heat' });
    await flushAsyncWork();

    session.emitPacket('setReply', acknowledgementPacket(45, {
      configOk: true,
      mainPower: true,
      mode: 2,
    }));
    session.emitPacket('property', displayPacket(110, { mode: 2 }));
    session.failPublish = true;
    publicationGate.resolve();

    assert.deepEqual(await result, {
      status: 'failed',
      sequence: 45,
      reason: 'publicationFailed',
    });
  });

  it('retains acknowledgement and observed state that arrive before publication completes', async () => {
    const session = new FakeControllerSession();
    const publicationGate = new Deferred<void>();
    session.publishGate = publicationGate;
    const controller = readyController(session, {
      initialSequence: 48,
    });
    let settled = false;
    const result = controller.execute({ type: 'airflowSpeed', speed: 60 }).then(value => {
      settled = true;
      return value;
    });
    await flushAsyncWork();

    session.emitPacket('setReply', acknowledgementPacket(48, {
      configOk: true,
      airflowSpeed: 60,
    }));
    session.emitPacket('property', displayPacket(111, {
      mode: 1,
      airflowSpeed: 60,
    }));
    await flushAsyncWork();
    assert.equal(settled, false);

    publicationGate.resolve();
    assert.deepEqual(await result, { status: 'confirmed', sequence: 48 });
    assert.equal(session.requestStateCalls, 0);
  });

  it('rejects contradictory same-sequence acknowledgements without overriding publication failure', async () => {
    const publishedSession = new FakeControllerSession();
    const publishedController = readyController(publishedSession, {
      initialSequence: 49,
    });
    const publishedResult = publishedController.execute({
      type: 'airflowSpeed',
      speed: 60,
    });
    await flushAsyncWork();
    publishedSession.emitPacket('setReply', acknowledgementPacket(49, {
      configOk: true,
      airflowSpeed: 60,
    }));
    publishedSession.emitPacket('setReply', acknowledgementPacket(49, {
      configOk: false,
      airflowSpeed: 60,
    }));
    assert.deepEqual(await publishedResult, {
      status: 'failed',
      sequence: 49,
      reason: 'acknowledgementRejected',
    });

    const earlySession = new FakeControllerSession();
    const earlyGate = new Deferred<void>();
    earlySession.publishGate = earlyGate;
    const earlyController = readyController(earlySession, {
      initialSequence: 51,
    });
    const earlyResult = earlyController.execute({ type: 'airflowSpeed', speed: 60 });
    await flushAsyncWork();
    earlySession.emitPacket('setReply', acknowledgementPacket(51, {
      configOk: true,
      airflowSpeed: 60,
    }));
    earlySession.emitPacket('property', displayPacket(112, {
      mode: 1,
      airflowSpeed: 60,
    }));
    earlySession.emitPacket('setReply', acknowledgementPacket(51, {
      configOk: false,
      airflowSpeed: 60,
    }));
    earlyGate.resolve();
    assert.deepEqual(await earlyResult, {
      status: 'failed',
      sequence: 51,
      reason: 'acknowledgementRejected',
    });

    const failedSession = new FakeControllerSession();
    const failedGate = new Deferred<void>();
    failedSession.publishGate = failedGate;
    const failedController = readyController(failedSession, {
      initialSequence: 52,
    });
    const failedResult = failedController.execute({ type: 'airflowSpeed', speed: 60 });
    await flushAsyncWork();
    failedSession.emitPacket('setReply', acknowledgementPacket(52, {
      configOk: false,
      airflowSpeed: 60,
    }));
    failedSession.emitPacket('setReply', acknowledgementPacket(52, {
      configOk: true,
      airflowSpeed: 60,
    }));
    failedSession.emitPacket('property', displayPacket(113, {
      mode: 1,
      airflowSpeed: 60,
    }));
    failedSession.failPublish = true;
    failedGate.resolve();
    assert.deepEqual(await failedResult, {
      status: 'failed',
      sequence: 52,
      reason: 'publicationFailed',
    });
  });

  it('ignores semantically identical duplicate acknowledgements', async () => {
    const session = new FakeControllerSession();
    const controller = readyController(session, {
      initialSequence: 53,
    });
    const result = controller.execute({ type: 'airflowSpeed', speed: 80 });
    await flushAsyncWork();
    const acknowledgement = {
      configOk: true,
      airflowSpeed: 80,
    };
    session.emitPacket('setReply', acknowledgementPacket(53, acknowledgement));
    session.emitPacket('setReply', acknowledgementPacket(53, acknowledgement));
    session.emitPacket('property', displayPacket(114, {
      mode: 1,
      airflowSpeed: 80,
    }));
    assert.deepEqual(await result, { status: 'confirmed', sequence: 53 });
  });

  it('requires command-specific fields in the post-ack display update', async () => {
    const session = new FakeControllerSession();
    const controller = new Wave3Controller(TEST_SERIAL, session, {
      initialSequence: 46,
    });
    session.emitPacket('property', displayPacket(120, {
      mode: 1,
      sleepState: 0,
      targetTemperature: 22,
    }));

    let settled = false;
    const result = controller.execute({
      type: 'targetTemperature',
      celsius: 22,
    }).then(value => {
      settled = true;
      return value;
    });
    await flushAsyncWork();
    session.emitPacket('setReply', acknowledgementPacket(46, {
      configOk: true,
      targetTemperature: 22,
    }));
    session.emitPacket('property', displayPacket(121, {
      modeParametersOnly: true,
      mode: 1,
      ambientTemperature: 25,
    }));
    session.emitPacket('property', displayPacket(122, {
      modeParametersOnly: true,
      mode: 1,
      targetTemperature: 99,
    }));
    await flushAsyncWork();
    assert.equal(settled, false);

    session.emitPacket('property', displayPacket(123, {
      modeParametersOnly: true,
      mode: 1,
      targetTemperature: 22,
    }));
    assert.deepEqual(await result, { status: 'confirmed', sequence: 46 });
  });

  it('requires value-consistent post-ack evidence for power', async () => {
    const session = new FakeControllerSession();
    const controller = new Wave3Controller(TEST_SERIAL, session, {
      initialSequence: 47,
    });
    session.emitPacket('property', displayPacket(130, {
      mode: 1,
      sleepState: 1,
    }));
    assert.equal(controller.snapshot.state.powered, false);

    let settled = false;
    const result = controller.execute({ type: 'power', on: false }).then(value => {
      settled = true;
      return value;
    });
    await flushAsyncWork();
    session.emitPacket('setReply', acknowledgementPacket(47, {
      configOk: true,
      systemPaused: true,
    }));
    session.emitPacket('property', displayPacket(131, { mode: 1 }));
    await flushAsyncWork();
    assert.equal(settled, false);

    session.emitPacket('property', displayPacket(132, {
      modeParametersOnly: true,
      sleepState: 1,
    }));
    assert.deepEqual(await result, { status: 'confirmed', sequence: 47 });
  });

  it('rejects negative and incomplete matching acknowledgements', async () => {
    for (const acknowledgement of [
      { configOk: false, airflowSpeed: 60 },
      { airflowSpeed: 60 },
    ]) {
      const session = new FakeControllerSession();
      const controller = readyController(session, {
        initialSequence: 50,
      });
      const result = controller.execute({ type: 'airflowSpeed', speed: 60 });
      await flushAsyncWork();
      session.emitPacket('setReply', acknowledgementPacket(50, acknowledgement));
      assert.deepEqual(await result, {
        status: 'failed',
        sequence: 50,
        reason: 'acknowledgementRejected',
      });
      controller.stop();
    }
  });

  it('ignores a foreign same-sequence acknowledgement and waits for its own evidence', async () => {
    const session = new FakeControllerSession();
    const controller = readyController(session, {
      initialSequence: 54,
    });
    const result = controller.execute({ type: 'airflowSpeed', speed: 60 });
    await flushAsyncWork();

    session.emitPacket('setReply', acknowledgementPacket(54, {
      configOk: true,
      airflowSpeed: 80,
    }));
    session.emitPacket('setReply', acknowledgementPacket(54, {
      configOk: true,
      airflowSpeed: 60,
    }));
    session.emitPacket('property', displayPacket(114, {
      mode: 1,
      airflowSpeed: 60,
    }));

    assert.deepEqual(await result, { status: 'confirmed', sequence: 54 });
  });

  it('applies acknowledgement and observed-state policy to every command shape', async () => {
    const cases: Array<{
      command: Wave3Command;
      acknowledgement: Parameters<typeof acknowledgementPacket>[1];
      display: Parameters<typeof displayPacket>[1];
    }> = [
      {
        command: { type: 'power', on: true },
        acknowledgement: { configOk: true, mainPower: true },
        display: { mode: 1 },
      },
      {
        command: { type: 'power', on: false },
        acknowledgement: { configOk: true, systemPaused: true },
        display: { mode: 0 },
      },
      {
        command: { type: 'mode', mode: 'heat' },
        acknowledgement: { configOk: true, mainPower: true, mode: 2 },
        display: { mode: 2 },
      },
      {
        command: { type: 'mode', mode: 'cool', targetTemperatureCelsius: 20 },
        acknowledgement: {
          configOk: true,
          mainPower: true,
          mode: 1,
          targetTemperature: 20,
        },
        display: { mode: 1, targetTemperature: 20 },
      },
      {
        command: {
          type: 'mode',
          mode: 'auto',
          targetTemperatureLowerCelsius: 18,
          targetTemperatureUpperCelsius: 23,
        },
        acknowledgement: {
          configOk: true,
          mainPower: true,
          mode: 5,
          lowerTemperature: 18,
          upperTemperature: 23,
        },
        display: { mode: 5, lowerTemperature: 18, upperTemperature: 23 },
      },
      {
        command: { type: 'targetTemperature', celsius: 21 },
        acknowledgement: { configOk: true, targetTemperature: 21 },
        display: { mode: 1, targetTemperature: 21 },
      },
      {
        command: {
          type: 'automaticTemperatureRange',
          lowerCelsius: 19,
          upperCelsius: 24,
        },
        acknowledgement: {
          configOk: true,
          lowerTemperature: 19,
          upperTemperature: 24,
        },
        display: {
          mode: 5,
          lowerTemperature: 19,
          upperTemperature: 24,
        },
      },
      {
        command: { type: 'airflowSpeed', speed: 80 },
        acknowledgement: { configOk: true, airflowSpeed: 80 },
        display: { mode: 1, airflowSpeed: 80 },
      },
      {
        command: { type: 'submode', submode: 3 },
        acknowledgement: { configOk: true, submode: 3 },
        display: { mode: 1, submode: 3 },
      },
    ];

    for (const { command, acknowledgement, display } of cases) {
      const session = new FakeControllerSession();
      const controller = readyController(session, {
        initialSequence: 90,
      });
      const result = controller.execute(command);
      await flushAsyncWork();
      session.emitPacket('setReply', acknowledgementPacket(90, acknowledgement));
      session.emitPacket('property', displayPacket(1, display));
      assert.deepEqual(await result, { status: 'confirmed', sequence: 90 });
      controller.stop();
    }
  });

  it('accumulates split acknowledgements for composite commands', async () => {
    const modeSession = new FakeControllerSession();
    const modeController = readyController(modeSession, {
      initialSequence: 91,
    });
    let modeSettled = false;
    const modeResult = modeController.execute({
      type: 'mode',
      mode: 'heat',
      targetTemperatureCelsius: 20,
    })
      .then(result => {
        modeSettled = true;
        return result;
      });
    await flushAsyncWork();
    modeSession.emitPacket('setReply', acknowledgementPacket(91, {
      configOk: true,
      mainPower: true,
    }));
    await flushAsyncWork();
    assert.equal(modeSettled, false);
    modeSession.emitPacket('setReply', acknowledgementPacket(91, {
      configOk: true,
      mode: 2,
    }));
    await flushAsyncWork();
    assert.equal(modeSettled, false);
    modeSession.emitPacket('setReply', acknowledgementPacket(91, {
      configOk: true,
      targetTemperature: 20,
    }));
    modeSession.emitPacket('property', displayPacket(2, {
      mode: 2,
      targetTemperature: 20,
    }));
    assert.deepEqual(await modeResult, { status: 'confirmed', sequence: 91 });

    const rangeSession = new FakeControllerSession();
    const rangeController = readyController(rangeSession, {
      initialSequence: 92,
    });
    const rangeResult = rangeController.execute({
      type: 'automaticTemperatureRange',
      lowerCelsius: 19,
      upperCelsius: 24,
    });
    await flushAsyncWork();
    rangeSession.emitPacket('setReply', acknowledgementPacket(92, {
      configOk: true,
      upperTemperature: 24,
    }));
    rangeSession.emitPacket('setReply', acknowledgementPacket(92, {
      configOk: true,
      lowerTemperature: 19,
    }));
    rangeSession.emitPacket('property', displayPacket(3, {
      mode: 5,
      lowerTemperature: 19,
      upperTemperature: 24,
    }));
    assert.deepEqual(await rangeResult, { status: 'confirmed', sequence: 92 });
  });

  it('serializes conflicting commands and times out without optimistic state', async () => {
    const session = new FakeControllerSession();
    const clock = new FakeClock();
    const controller = readyController(session, {
      schedule: clock.schedule,
      commandTimeoutMilliseconds: 100,
      initialSequence: 60,
    });
    const first = controller.execute({ type: 'targetTemperature', celsius: 20 });
    const second = controller.execute({ type: 'targetTemperature', celsius: 22 });
    await flushAsyncWork();
    assert.equal(session.publishCalls.length, 1);
    assert.equal(controller.snapshot.state.targetTemperatureCelsius, undefined);

    clock.advance(100);
    assert.deepEqual(await first, {
      status: 'failed',
      sequence: 60,
      reason: 'timeout',
    });
    await flushAsyncWork();
    assert.equal(session.publishCalls.length, 2);

    session.emitPacket('setReply', acknowledgementPacket(61, {
      configOk: true,
      targetTemperature: 22,
    }));
    session.emitPacket('property', displayPacket(200, {
      mode: 1,
      targetTemperature: 22,
    }));
    assert.deepEqual(await second, { status: 'confirmed', sequence: 61 });
  });

  it('aborts hanging publication on timeout and stop without blocking command completion', async () => {
    const timeoutSession = new FakeControllerSession();
    timeoutSession.publishGate = new Deferred<void>();
    const clock = new FakeClock();
    const timeoutController = readyController(timeoutSession, {
      schedule: clock.schedule,
      commandTimeoutMilliseconds: 100,
      initialSequence: 65,
    });
    const timedOut = timeoutController.execute({ type: 'power', on: true });
    await flushAsyncWork();
    clock.advance(100);
    assert.deepEqual(await timedOut, {
      status: 'failed',
      sequence: 65,
      reason: 'timeout',
    });
    await flushAsyncWork();
    assert.equal(timeoutSession.abortedPublishCalls, 1);

    assert.deepEqual(
      await timeoutController.execute({ type: 'power', on: false }),
      { status: 'failed', sequence: 66, reason: 'disconnected' },
    );
    timeoutSession.publishGate = undefined;
    timeoutSession.emitState('online');
    timeoutSession.emitPacket('property', displayPacket(204, {
      mode: 1,
      sleepState: 0,
    }));
    const recovered = timeoutController.execute({ type: 'airflowSpeed', speed: 40 });
    await flushAsyncWork();
    timeoutSession.emitPacket('setReply', acknowledgementPacket(67, {
      configOk: true,
      airflowSpeed: 40,
    }));
    timeoutSession.emitPacket('property', displayPacket(205, {
      mode: 1,
      airflowSpeed: 40,
    }));
    assert.deepEqual(await recovered, { status: 'confirmed', sequence: 67 });

    const stopSession = new FakeControllerSession();
    stopSession.publishGate = new Deferred<void>();
    const stopController = readyController(stopSession, {
      initialSequence: 75,
    });
    const stopped = stopController.execute({ type: 'power', on: true });
    await flushAsyncWork();
    stopController.stop();
    assert.deepEqual(await stopped, {
      status: 'failed',
      sequence: 75,
      reason: 'stopped',
    });
    await flushAsyncWork();
    assert.equal(stopSession.abortedPublishCalls, 1);
  });

  it('fails commands predictably on publication, disconnect, and stop', async () => {
    const publicationSession = new FakeControllerSession();
    publicationSession.failPublish = true;
    const publicationController = readyController(publicationSession, {
      initialSequence: 70,
    });
    assert.deepEqual(
      await publicationController.execute({ type: 'power', on: true }),
      { status: 'failed', sequence: 70, reason: 'publicationFailed' },
    );

    const disconnectedSession = new FakeControllerSession();
    const disconnectedController = readyController(disconnectedSession, {
      initialSequence: 80,
    });
    const disconnected = disconnectedController.execute({ type: 'power', on: false });
    await flushAsyncWork();
    disconnectedSession.emitState('offline');
    assert.deepEqual(await disconnected, {
      status: 'failed',
      sequence: 80,
      reason: 'disconnected',
    });
    assert.equal(disconnectedController.snapshot.availability, 'reconnecting');

    disconnectedController.stop();
    assert.deepEqual(
      await disconnectedController.execute({ type: 'power', on: true }),
      { status: 'failed', sequence: 81, reason: 'stopped' },
    );
    assert.equal(disconnectedController.snapshot.availability, 'stopped');
  });

  it('performs full cleanup when the session stops', () => {
    const session = new FakeControllerSession();
    const clock = new FakeClock();
    const controller = new Wave3Controller(TEST_SERIAL, session, {
      schedule: clock.schedule,
    });
    session.emitPacket('property', displayPacket(1, { mode: 1, sleepState: 0 }));
    assert.equal(session.totalListenerCount(), 3);
    assert.equal(clock.taskCount, 1);

    session.emitState('stopped');

    assert.equal(controller.snapshot.availability, 'stopped');
    assert.equal(session.totalListenerCount(), 0);
    assert.equal(clock.taskCount, 0);
  });
});

class FakeControllerSession implements Wave3ControllerSession {
  public state: CloudSessionState = 'online';
  public generation = 0;
  public readonly publishCalls: Array<{ serialNumber: string; payload: Uint8Array }> = [];
  public requestStateCalls = 0;
  public abortedPublishCalls = 0;
  public failPublish = false;
  public publishGate?: Deferred<void>;
  private readonly messageListeners = new Set<(message: Wave3InboundMessage) => void>();
  private readonly errorListeners = new Set<(error: EcoFlowCloudSessionError) => void>();
  private readonly stateListeners = new Set<(state: CloudSessionState) => void>();

  onMessage(listener: (message: Wave3InboundMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: EcoFlowCloudSessionError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onStateChange(listener: (state: CloudSessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async publishCommand(
    serialNumber: string,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    this.publishCalls.push({ serialNumber, payload });
    try {
      await waitForGate(this.publishGate, signal);
    } catch {
      this.abortedPublishCalls += 1;
      this.emitState('failed');
      throw new Error('synthetic publish cancellation');
    }
    if (this.failPublish) {
      this.emitState('failed');
      throw new Error('synthetic publish failure');
    }
  }

  async requestState(): Promise<void> {
    this.requestStateCalls += 1;
  }

  emitPacket(kind: Wave3InboundMessage['kind'], payload: Uint8Array): void {
    for (const listener of this.messageListeners) {
      listener({
        serialNumber: TEST_SERIAL,
        kind,
        payload,
        generation: this.generation,
      });
    }
  }

  emitState(state: CloudSessionState): void {
    if (state === 'starting') {
      this.generation += 1;
    }
    this.state = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  totalListenerCount(): number {
    return this.messageListeners.size
      + this.errorListeners.size
      + this.stateListeners.size;
  }
}

function readyController(
  session: FakeControllerSession,
  options: ConstructorParameters<typeof Wave3Controller>[2] = {},
): Wave3Controller {
  const controller = new Wave3Controller(TEST_SERIAL, session, options);
  session.emitPacket('property', displayPacket(0, { mode: 1, sleepState: 0 }));
  assert.equal(controller.snapshot.availability, 'online');
  return controller;
}

async function waitForGate(
  gate: Deferred<void> | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (gate === undefined) {
    return;
  }
  if (signal === undefined) {
    await gate.promise;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(new Error('synthetic abort'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    void gate.promise.then(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    });
  });
}

class FakeClock {
  public now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; callback: () => void }>();

  public readonly schedule = (
    callback: () => void,
    delayMilliseconds: number,
  ): (() => void) => {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + delayMilliseconds, callback });
    return () => this.tasks.delete(id);
  };

  get taskCount(): number {
    return this.tasks.size;
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.due <= this.now)
      .sort((left, right) => left[1].due - right[1].due);
    for (const [id, task] of due) {
      if (this.tasks.delete(id)) {
        task.callback();
      }
    }
  }
}

function displayPacket(
  sequence: number,
  values: {
    mode?: number;
    modeParametersOnly?: boolean;
    sleepState?: number;
    ambientTemperature?: number;
    targetTemperature?: number;
    airflowSpeed?: number;
    lowerTemperature?: number;
    upperTemperature?: number;
    submode?: number;
  },
): Uint8Array {
  const mode = values.mode ?? 1;
  const listInfo = Array.from({ length: mode + 1 }, () => ({}));
  listInfo[mode] = {
    tempSet: values.targetTemperature,
    airflowSpeed: values.airflowSpeed,
    tempThermostaticLowerLimit: values.lowerTemperature,
    tempThermostaticUpperLimit: values.upperTemperature,
    submode: values.submode,
  };
  const display = create(Wave3DisplayPropertyUploadSchema, {
    ...(!values.modeParametersOnly && values.mode !== undefined
      ? { waveOperatingMode: values.mode }
      : {}),
    ...(values.ambientTemperature === undefined
      ? {}
      : { tempAmbient: values.ambientTemperature }),
    ...(values.sleepState === undefined
      ? {}
      : { devSleepState: values.sleepState }),
    waveModeInfo: { listInfo },
  });
  return envelope(
    21,
    sequence,
    toBinary(Wave3DisplayPropertyUploadSchema, display),
  );
}

function acknowledgementPacket(
  sequence: number,
  values: {
    configOk?: boolean;
    mainPower?: boolean;
    mode?: number;
    airflowSpeed?: number;
    targetTemperature?: number;
    lowerTemperature?: number;
    upperTemperature?: number;
    submode?: number;
    systemPaused?: boolean;
  },
): Uint8Array {
  const acknowledgement = create(Wave3ConfigWriteAckSchema, {
    configOk: values.configOk,
    cfgMainPower: values.mainPower,
    cfgWaveOperatingMode: values.mode,
    cfgAirflowSpeed: values.airflowSpeed,
    cfgTempSet: values.targetTemperature,
    cfgTempThermostaticLowerLimit: values.lowerTemperature,
    cfgTempThermostaticUpperLimit: values.upperTemperature,
    cfgWaveOperatingSubmode: values.submode,
    cfgSysPause: values.systemPaused,
  });
  return envelope(
    18,
    sequence,
    toBinary(Wave3ConfigWriteAckSchema, acknowledgement),
  );
}

function runtimePacket(
  sequence: number,
  values: {
    indoorReturnAir?: number;
    condenser?: number;
    pdFirmware?: number;
    bmsFirmware?: number;
  },
): Uint8Array {
  const runtime = create(Wave3RuntimePropertyUploadSchema, {
    pdFirmVer: values.pdFirmware,
    bmsFirmVer: values.bmsFirmware,
    tempIndoorReturnAir: values.indoorReturnAir,
    tempCondenser: values.condenser,
  });
  return envelope(
    22,
    sequence,
    toBinary(Wave3RuntimePropertyUploadSchema, runtime),
  );
}

function quotaReply(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    operateType: 'latestQuotas',
    data,
  }));
}

function envelope(commandId: number, sequence: number, payload: Uint8Array): Uint8Array {
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

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
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
