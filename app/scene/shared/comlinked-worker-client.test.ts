import assert from 'node:assert/strict';
import test from 'node:test';
import * as Comlink from 'comlink';
import { ComlinkedWorkerClient } from './comlinked-worker-client';
import { WorkerClientError } from './worker-errors';

const RELEASE_PROXY = Symbol('releaseProxy');

interface TestProxy {
  invoke: () => Promise<string>;
}

class FakeWorker extends EventTarget {
  terminateCount = 0;

  terminate(): void {
    this.terminateCount += 1;
  }
}

class TestWorkerClient extends ComlinkedWorkerClient<TestProxy> {
  constructor(worker: Worker, proxy: TestProxy, timeoutMs = 25) {
    super(worker, {
      name: 'test',
      defaultTimeoutMs: timeoutMs,
      wrap: () => proxy as unknown as Comlink.Remote<TestProxy>,
      releaseProxySymbol: RELEASE_PROXY,
    });
  }

  run(createCall: () => Promise<string>, timeoutMs?: number): Promise<string> {
    return this.withTimeout(createCall, timeoutMs ? { timeoutMs } : undefined);
  }
}

function createClient(timeoutMs = 25) {
  const worker = new FakeWorker();
  let releaseCount = 0;
  const proxy: TestProxy & Record<symbol, unknown> = {
    invoke: () => Promise.resolve('ok'),
    [RELEASE_PROXY]: () => {
      releaseCount += 1;
    },
  };

  const client = new TestWorkerClient(worker as unknown as Worker, proxy, timeoutMs);

  return {
    client,
    worker,
    proxy,
    get releaseCount() {
      return releaseCount;
    },
  };
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

  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof WorkerClientError);
    assert.equal(error.code, 'cancelled');
    return true;
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

  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof WorkerClientError);
    assert.equal(error.code, 'worker-error');
    return true;
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

  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof WorkerClientError);
    assert.equal(error.code, 'message-error');
    return true;
  });
});

test('withTimeout returns timeout error when call does not settle in time', async () => {
  const { client } = createClient(5);
  const pending = new Promise<string>(() => {
    // intentionally unresolved
  });

  await assert.rejects(client.run(() => pending), (error: unknown) => {
    assert.ok(error instanceof WorkerClientError);
    assert.equal(error.code, 'timeout');
    return true;
  });
});

test('withTimeout maps synchronous proxy call failures to terminated', async () => {
  const { client } = createClient();

  await assert.rejects(
    client.run(() => {
      throw new TypeError('MessagePort is already detached');
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerClientError);
      assert.equal(error.code, 'terminated');
      return true;
    }
  );
});
