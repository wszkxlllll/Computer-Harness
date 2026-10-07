import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchGlmHttpClient, type GlmTransportEvidence } from './index.js';

let clock = 0;
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const response = (json: () => Promise<unknown> = vi.fn(async () => ({ synthetic: true }))) => ({ ok: true, status: 200, json });
const invoke = (controller = new AbortController(), evidence: GlmTransportEvidence[] = [], body: Record<string, unknown> = {}) =>
  new FetchGlmHttpClient({ requestTimeoutMs: 10 }).post('https://fixture.invalid/no-network', body, {}, controller.signal,
    { payloadHash: 'a'.repeat(64), onTransportEvidence: (item) => evidence.push(item) })
    .then((value) => ({ state: 'success', value }), (error: unknown) => ({ state: 'failure', error }));

describe('independent bounded GLM settlement', () => {
  beforeEach(() => { clock = 0; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(performance, 'now').mockImplementation(() => clock); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('fetch that ignores Abort and never settles cannot keep the local request pending', async () => {
    const transport = deferred<Response>(), evidence: GlmTransportEvidence[] = [];
    const fetchMock = vi.fn(() => transport.promise); vi.stubGlobal('fetch', fetchMock);
    const pending = invoke(undefined, evidence); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ state: 'failure', error: { code: 'GLM_REQUEST_TIMEOUT', retryable: false, retryMode: 'feedback' } });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(evidence.at(-1)).toMatchObject({ stage: 'fetch_failed', phase: 'awaiting_headers', outcome: 'timeout' }); expect(vi.getTimerCount()).toBe(0);
  });
  it('body that ignores Abort and never settles preserves HTTP status at bounded timeout', async () => {
    const body = deferred<unknown>(), evidence: GlmTransportEvidence[] = [], json = vi.fn(() => body.promise);
    vi.stubGlobal('fetch', vi.fn(async () => response(json)));
    const pending = invoke(undefined, evidence); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ state: 'failure', error: { code: 'GLM_REQUEST_TIMEOUT', retryable: false } });
    expect(evidence.at(-1)).toMatchObject({ stage: 'body_failed', phase: 'reading_body', outcome: 'timeout', httpStatus: 200 }); expect(json).toHaveBeenCalledTimes(1);
  });
  it('late headers after local timeout cannot read a body or emit success', async () => {
    const transport = deferred<Response>(), evidence: GlmTransportEvidence[] = [], json = vi.fn(async () => ({ late: true }));
    vi.stubGlobal('fetch', vi.fn(() => transport.promise)); const pending = invoke(undefined, evidence); await flush();
    clock = 10; await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject({ state: 'failure' }); const before = JSON.stringify(evidence);
    transport.resolve(response(json) as unknown as Response); await flush(); expect(json).not.toHaveBeenCalled(); expect(JSON.stringify(evidence)).toBe(before); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('late body resolution after timeout cannot rewrite settled failure evidence', async () => {
    const body = deferred<unknown>(), evidence: GlmTransportEvidence[] = []; vi.stubGlobal('fetch', vi.fn(async () => response(vi.fn(() => body.promise))));
    const pending = invoke(undefined, evidence); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject({ state: 'failure' });
    const before = JSON.stringify(evidence); body.resolve({ late: true }); await flush(); expect(JSON.stringify(evidence)).toBe(before); expect(evidence.some((item) => item.outcome === 'success')).toBe(false);
  });
  it('late rejected transport remains observed after local timeout', async () => {
    const transport = deferred<Response>(), unhandled: unknown[] = [], listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try { vi.stubGlobal('fetch', vi.fn(() => transport.promise)); const pending = invoke(); await flush(); clock = 10; await vi.advanceTimersByTimeAsync(10); await pending;
      transport.reject(new Error('late synthetic failure')); await flush(); await vi.advanceTimersByTimeAsync(0); expect(unhandled).toEqual([]); }
    finally { process.removeListener('unhandledRejection', listener); }
  });
  it('Run cancellation preserves a null reason when the transport ignores Abort', async () => {
    const controller = new AbortController(); vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = invoke(controller); controller.abort(null); const result = await pending;
    expect(result.state).toBe('failure'); expect('error' in result && result.error).toBe(null); expect(vi.getTimerCount()).toBe(0);
  });
  it('serialization toJSON cancellation must not invoke fetch', async () => {
    const controller = new AbortController(), reason = { synthetic: 'cancelled inside serialization' }, fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const body = { toJSON() { controller.abort(reason); return {}; } }; const result = await invoke(controller, [], body);
    expect(result.state).toBe('failure'); expect('error' in result && result.error).toBe(reason); expect(fetchMock).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('serialization advancing the monotonic clock rejects before fetch without timer delivery', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); const result = await invoke(undefined, [], { toJSON() { clock = 11; return {}; } });
    expect(result).toMatchObject({ state: 'failure', error: { code: 'GLM_REQUEST_TIMEOUT', retryable: false } }); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('late resolved headers are refused by monotonic guard without reading json', async () => {
    const json = vi.fn(async () => ({})); vi.stubGlobal('fetch', vi.fn(async () => { clock = 11; return response(json); }));
    expect(await invoke()).toMatchObject({ state: 'failure', error: { code: 'GLM_REQUEST_TIMEOUT' } }); expect(json).not.toHaveBeenCalled();
  });
  it('body completion beyond logical deadline is refused even before timer delivery', async () => {
    const evidence: GlmTransportEvidence[] = []; vi.stubGlobal('fetch', vi.fn(async () => response(vi.fn(async () => { clock = 11; return {}; }))));
    expect(await invoke(undefined, evidence)).toMatchObject({ state: 'failure', error: { code: 'GLM_REQUEST_TIMEOUT' } }); expect(evidence.at(-1)).toMatchObject({ stage: 'body_failed', outcome: 'timeout' }); expect(evidence.some((item) => item.outcome === 'success')).toBe(false);
  });
  it('diagnostic cancellation before fetch invocation prevents transport dispatch', async () => {
    const controller = new AbortController(), reason = new Error('synthetic diagnostic cancellation'), fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const pending = new FetchGlmHttpClient({ requestTimeoutMs: 10 }).post('https://fixture.invalid', {}, {}, controller.signal,
      { payloadHash: 'b'.repeat(64), onTransportEvidence(item) { if (item.stage === 'fetch_invoked') controller.abort(reason); } });
    await expect(pending).rejects.toBe(reason); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('headers diagnostic cancellation prevents body invocation and retains first Run reason', async () => {
    const controller = new AbortController(), reason = new Error('synthetic after headers cancellation'), json = vi.fn(async () => ({})); vi.stubGlobal('fetch', vi.fn(async () => response(json)));
    const pending = new FetchGlmHttpClient({ requestTimeoutMs: 10 }).post('https://fixture.invalid', {}, {}, controller.signal,
      { payloadHash: 'c'.repeat(64), onTransportEvidence(item) { if (item.stage === 'headers_received') controller.abort(reason); } });
    await expect(pending).rejects.toBe(reason); expect(json).not.toHaveBeenCalled();
  });
  it('completed-body evidence is retained but return must honor observed Run cancellation', async () => {
    const controller = new AbortController(), reason = new Error('synthetic cancellation before return'), evidence: GlmTransportEvidence[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const pending = new FetchGlmHttpClient({ requestTimeoutMs: 10 }).post('https://fixture.invalid', {}, {}, controller.signal,
      { payloadHash: 'd'.repeat(64), onTransportEvidence(item) { evidence.push(item); if (item.stage === 'body_received') controller.abort(reason); } });
    await expect(pending).rejects.toBe(reason);
    expect(evidence.some(item => item.stage === 'body_received' && item.outcome === 'success')).toBe(true);
  });
  it('completed-body callback cannot allow returning a payload beyond logical deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const pending = new FetchGlmHttpClient({ requestTimeoutMs: 10 }).post('https://fixture.invalid', {}, {}, new AbortController().signal,
      { payloadHash: 'e'.repeat(64), onTransportEvidence(item) { if (item.stage === 'body_received') clock = 11; } });
    await expect(pending).rejects.toMatchObject({ code: 'GLM_REQUEST_TIMEOUT', retryable: false, retryMode: 'feedback' });
  });
});
