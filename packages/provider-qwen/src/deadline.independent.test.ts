import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchQwenHttpClient } from './index.js';

let clock = 0;
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const response = (json: () => Promise<unknown> = vi.fn(async () => ({ synthetic: true }))) => ({ ok: true, status: 200, json });
const invoke = (controller = new AbortController(), body: Record<string, unknown> = {}) =>
  new FetchQwenHttpClient({ requestTimeoutMs: 10 }).post('https://fixture.invalid/no-network', body, {}, controller.signal)
    .then(value => ({ state: 'success', value }), (error: unknown) => ({ state: 'failure', error }));
const timeout = { state: 'failure', error: { code: 'QWEN_REQUEST_TIMEOUT', retryable: false, retryMode: 'feedback' } };

describe('independent bounded Qwen settlement', () => {
  beforeEach(() => { clock = 0; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(performance, 'now').mockImplementation(() => clock); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('never settling fetch is locally bounded despite ignored Abort', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))); const pending = invoke(); await flush();
    clock = 10; await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject(timeout); expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('never settling body shares the original deadline', async () => {
    const body = deferred<unknown>(); vi.stubGlobal('fetch', vi.fn(async () => response(() => body.promise)));
    const pending = invoke(); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject(timeout); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('late headers cannot read body or retry', async () => {
    const transport = deferred<Response>(), json = vi.fn(async () => ({})); vi.stubGlobal('fetch', vi.fn(() => transport.promise));
    const pending = invoke(); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject(timeout);
    transport.resolve(response(json) as unknown as Response); await flush(); expect(json).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('late body success cannot rewrite settled failure', async () => {
    const body = deferred<unknown>(); vi.stubGlobal('fetch', vi.fn(async () => response(() => body.promise))); const pending = invoke(); await flush();
    clock = 10; await vi.advanceTimersByTimeAsync(10); const result = await pending; body.resolve({ late: true }); await flush(); expect(result).toMatchObject(timeout); expect(await pending).toBe(result);
  });
  it('late rejected body remains observed', async () => {
    const body = deferred<unknown>(), unhandled: unknown[] = [], listener = (reason: unknown) => unhandled.push(reason); process.on('unhandledRejection', listener);
    try { vi.stubGlobal('fetch', vi.fn(async () => response(() => body.promise))); const pending = invoke(); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10); await pending;
      body.reject(new Error('late synthetic')); await flush(); await vi.advanceTimersByTimeAsync(0); expect(unhandled).toEqual([]); }
    finally { process.removeListener('unhandledRejection', listener); }
  });
  it('pre-cancel preserves original reason and performs zero serialization/fetch', async () => {
    const controller = new AbortController(), reason = { synthetic: 'pre-cancel' }, serialize = vi.fn(() => ({})), fetchMock = vi.fn(); controller.abort(reason); vi.stubGlobal('fetch', fetchMock);
    const result = await invoke(controller, { toJSON: serialize }); expect('error' in result && result.error).toBe(reason); expect(serialize).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('ignored Abort preserves null Run reason', async () => {
    const controller = new AbortController(); vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))); const pending = invoke(controller); controller.abort(null);
    const result = await pending; expect('error' in result && result.error).toBe(null); expect(vi.getTimerCount()).toBe(0);
  });
  it('serialization cancellation performs zero dispatch', async () => {
    const controller = new AbortController(), reason = 0, fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const result = await invoke(controller, { toJSON() { controller.abort(reason); return {}; } }); expect('error' in result && result.error).toBe(reason); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('serialization crossing deadline rejects before dispatch without timer', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); expect(await invoke(undefined, { toJSON() { clock = 11; return {}; } })).toMatchObject(timeout); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('resolved headers crossing monotonic deadline cannot read json', async () => {
    const json = vi.fn(async () => ({})); vi.stubGlobal('fetch', vi.fn(async () => { clock = 11; return response(json); })); expect(await invoke()).toMatchObject(timeout); expect(json).not.toHaveBeenCalled();
  });
  it('body completed past monotonic deadline cannot succeed before timer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(async () => { clock = 11; return {}; }))); expect(await invoke()).toMatchObject(timeout);
  });
  it('timeout locks cause before reentrant Run cancellation from transport Abort', async () => {
    const controller = new AbortController(), runReason = new Error('later Run cancellation');
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => { init.signal!.addEventListener('abort', () => controller.abort(runReason)); return new Promise<Response>(() => {}); }));
    const pending = invoke(controller); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject(timeout); expect(controller.signal.reason).toBe(runReason);
  });
  it('Run-first cause is retained even after monotonic deadline', async () => {
    const controller = new AbortController(), reason = { synthetic: 'Run-first' }; vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = invoke(controller); controller.abort(reason); clock = 11; const result = await pending; expect('error' in result && result.error).toBe(reason); expect(vi.getTimerCount()).toBe(0);
  });
});
