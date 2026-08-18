import assert from 'node:assert/strict';
import test from 'node:test';
import * as Comlink from 'comlink';
import { ComlinkedWorkerClient } from './comlinked-worker-client';
import { WorkerClientError } from './worker-errors';

interface TestProxy {
  invoke: () => Promise<string>;
  [Comlink.releaseProxy]: () => void;
}

class FakeWorker extends EventTarget {
  terminateCount = 0;

  terminate(): void {
    this.terminateCount += 1;
  }
}

class TestWorkerClient extends ComlinkedWorkerClient<TestProxy> {
  constructor(worker: FakeWorker, proxy: TestProxy, timeoutMs = 25) {
    super(worker, {
      name: 'test',
      defaultTimeoutMs: timeoutMs,
      wrap: () => {
        // SAFETY: the test double implements TestProxy plus Comlink's release slot, which is the only Remote surface this client uses.
        return proxy as Comlink.Remote<TestProxy>;
      }
    });
  }

  run(createCall: () => Promise<string>, timeoutMs?: number): Promise<string> {
    return this.withTimeout(createCall, timeoutMs ? { timeoutMs } : undefined);
  }
}

function createClient(timeoutMs = 25) {
  const worker = new FakeWorker();
  let releaseCount = 0;
  const proxy: TestProxy = {
    invoke: () => Promise.resolve('ok'),
    [Comlink.releaseProxy]: () => {
      releaseCount += 1;
    }
  };

  const client = new TestWorkerClient(worker, proxy, timeoutMs);

  return {
    client,
    worker,
    proxy,
    get releaseCount() {
      return releaseCount;
    }
  };
}

function isCancelledWorkerError(error: WorkerClientError): boolean {
  return error.code === 'cancelled';
}

function isWorkerRuntimeError(error: WorkerClientError): boolean {
  return error.code === 'worker-error';
}

function isMessageError(error: WorkerClientError): boolean {
  return error.code === 'message-error';
}

function isTimeoutError(error: WorkerClientError): boolean {
  return error.code === 'timeout';
}

function isTerminatedError(error: WorkerClientError): boolean {
  return error.code === 'terminated';
}

test('dispose is idempotent and tears down worker once', () => {
  const ctx = createClient();
  const { client, worker } = ctx;

  client.dispose();
  client.dispose();

  assert.equal(worker.terminateCount, 1);
  assert.equal(ctx.releaseCount, 1);
});

test('cancelAllPending rejects in-flight call with cancelled error', async () => {
  const { client } = createClient(200);
  const pending = new Promise<string>(() => {
    // intentionally unresolved
  });

  const call = client.run(() => pending);
  client.cancelAllPending();

  await assert.rejects(call, (error) => {
    assert.ok(error instanceof WorkerClientError);
    return isCancelledWorkerError(error);
  });
});

test('worker runtime error rejects in-flight call and terminates worker', async () => {
  const ctx = createClient(200);
  const { client, worker } = ctx;
  const pending = new Promise<string>(() => {
    // intentionally unresolved
  });

  const call = client.run(() => pending);
  worker.dispatchEvent(new Event('error'));

  await assert.rejects(call, (error) => {
    assert.ok(error instanceof WorkerClientError);
    return isWorkerRuntimeError(error);
  });

  assert.equal(worker.terminateCount, 1);
  assert.equal(ctx.releaseCount, 1);
});

test('message serialization error rejects in-flight call', async () => {
  const { client, worker } = createClient(200);
  const pending = new Promise<string>(() => {
    // intentionally unresolved
  });

  const call = client.run(() => pending);
  worker.dispatchEvent(new Event('messageerror'));

  await assert.rejects(call, (error) => {
    assert.ok(error instanceof WorkerClientError);
    return isMessageError(error);
  });
});

test('withTimeout returns timeout error when call does not settle in time', async () => {
  const { client } = createClient(5);
  const pending = new Promise<string>(() => {
    // intentionally unresolved
  });

  await assert.rejects(
    client.run(() => pending),
    (error) => {
      assert.ok(error instanceof WorkerClientError);
      return isTimeoutError(error);
    }
  );
});

test('withTimeout maps synchronous proxy call failures to terminated', async () => {
  const { client } = createClient();

  await assert.rejects(
    client.run(() => {
      throw new TypeError('MessagePort is already detached');
    }),
    (error) => {
      assert.ok(error instanceof WorkerClientError);
      return isTerminatedError(error);
    }
  );
});
