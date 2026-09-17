// Audit probes: passing means the reported baseline defect was reproduced.
// Uses built repository code, synthetic data, and fake Computer/Provider only.
// Run from repository root after pnpm typecheck:
// node --test docs/verification/audit-39ff27f9-local-probes.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DefaultContextCompiler } from '../../packages/context/dist/index.js';
import { createMemoryTools, InMemoryMemoryStore } from '../../packages/memory/dist/index.js';
import { RunController, DefaultRuntimePolicy, ToolRegistry } from '../../packages/runtime/dist/index.js';
import { initialRunSnapshot } from '../../packages/trajectory/dist/index.js';
import { LayeredRiskGuard, ScriptedRiskAssessor } from '../../packages/risk-guard/dist/index.js';
import { buildTuiFrame } from '../../apps/cli/dist/tui.js';

const features = { planning: 'off', memory: 'facts-v1', batching: 'off' };
const baseFeatures = { ...features, memory: 'off' };
const signal = new AbortController().signal;
const viewport = { width: 640, height: 360, coordinateSpace: 'physical' };
const session = { id: 'audit-fake', backend: 'fake', viewport, capabilities: { screenshot: true, pointer: true, keyboard: true, accessibility: false }, openedAt: '2026-09-17T00:00:00Z' };
const event = (sequence, data) => ({ eventId: `event-${sequence}`, sequence, runId: 'audit-run', occurredAt: '2026-09-17T00:00:00Z', ...data });

test('F02: real compiler drops an authoritative correction under token pressure', async () => {
  const compiler = new DefaultContextCompiler(new ToolRegistry(), { features: baseFeatures });
  const input = { runId: 'audit-run', goal: 'Submit a form', recentEvents: [], features: baseFeatures };
  const fixed = (await compiler.compile(input, signal)).contextBudget.estimatedFixedTextTokens;
  const response = (id, padding = '') => ({ type: 'model.response.received', turn: { type: 'tool_calls', calls: [{ id, name: 'click', arguments: { x: 1, y: 2 } }], assistantText: padding } });
  const result = await compiler.compile({ ...input, context: { mode: 'recent', maxHistoryEvents: 20, maxInputTokens: fixed + 250 }, recentEvents: [
    event(0, { type: 'user.input.received', text: 'DO_NOT_SUBMIT_SENTINEL' }),
    event(1, response('old', 'x'.repeat(5000))),
    event(2, { type: 'tool.call.completed', result: { callId: 'old', status: 'completed', output: {} } }),
    event(3, response('new')),
    event(4, { type: 'tool.call.completed', result: { callId: 'new', status: 'completed', output: {} } }),
  ] }, signal);
  assert.equal(JSON.stringify(result.messages).includes('DO_NOT_SUBMIT_SENTINEL'), false);
  assert.equal(JSON.stringify(result.messages).includes('Submit a form'), true);
});

test('F05: real compiler exceeds budget for one event and for oversized fixed-only input', async () => {
  const compiler = new DefaultContextCompiler(new ToolRegistry(), { features: baseFeatures });
  const input = { runId: 'audit-run', goal: 'hello', recentEvents: [], features: baseFeatures };
  const fixed = (await compiler.compile(input, signal)).contextBudget.estimatedFixedTextTokens;
  const result = await compiler.compile({ ...input, context: { maxInputTokens: fixed + 100 }, recentEvents: [event(0, { type: 'user.input.received', text: 'x'.repeat(8000) })] }, signal);
  assert.ok(result.contextBudget.estimatedInputTokens > fixed + 100);
  const fixedOnly = await compiler.compile({ ...input, goal: 'x'.repeat(8000), context: { maxInputTokens: 100 } }, signal);
  assert.ok(fixedOnly.contextBudget.estimatedInputTokens > 100);
});

function harness(turns, planning = 'off', close = async () => {}) {
  const store = new InMemoryMemoryStore();
  const registry = new ToolRegistry();
  registry.registerMany(createMemoryTools(store));
  const events = [];
  const config = { ...features, planning };
  const controller = new RunController({
    runId: 'audit-run', provider: { id: 'scripted', async generate() { const turn = turns.shift(); if (!turn) throw new Error('script exhausted'); return turn; } },
    computer: { async open() { return session; }, async observe() { return { capturedAt: '2026-09-17T00:00:00Z', viewport, screenshot: { mediaType: 'image/png', data: new Uint8Array([1]) } }; }, async execute() { throw new Error('GUI forbidden in audit'); }, close },
    contextCompiler: new DefaultContextCompiler(registry, { features: config }), toolRegistry: registry, features: config,
    policy: new DefaultRuntimePolicy(1, 8),
    eventWriter: { async append(draft) { const committed = { ...draft, sequence: events.length }; events.push(committed); return committed; }, async flush() {}, async close() {} },
    assetStore: { async put(input) { return { assetId: input.assetId, relativePath: input.relativePath, mediaType: input.mediaType, byteLength: input.data.length }; } },
  });
  return { controller, store, events };
}
const write = (id, value, links) => ({ type: 'tool_calls', calls: [{ id, name: 'memory_write_fact', arguments: { key: 'destination', value, ...(links ? { relatedTaskIds: links } : {}) } }] });
const finish = () => ({ type: 'finish', summary: 'audit fixture finished', reportedStatus: 'success' });

for (const planning of ['off', 'tasks-v1']) {
  test(`F03: Runtime plus real Memory tool persists invalid replacement with Planning ${planning}`, async () => {
    const h = harness([write('create', 'old'), write('same', 'old', ['missing-task']), write('replace', 'new', ['missing-task']), finish()], planning);
    await h.controller.start('Synthetic memory mutation test');
    const facts = (await h.store.get('audit-run')).facts;
    assert.ok(h.events.some(e => e.type === 'tool.call.failed' && e.result.callId === 'same'));
    assert.ok(h.events.some(e => e.type === 'memory.updated' && e.mutation.operation === 'supersede_fact'));
    assert.equal(facts.find(f => f.value === 'old').status, 'superseded');
    assert.deepEqual(facts.find(f => f.value === 'new').relatedTaskIds, ['missing-task']);
    assert.deepEqual(h.controller.getSnapshot().memory.facts, facts);
  });
}

test('F08: full local RiskGuard allows a mixed payment description containing view', async () => {
  const base = { runId: 'audit-run', goal: 'Pay', recentUserInputs: [], snapshot: initialRunSnapshot('audit-run'), candidate: { session, decisionObservation: { id: 'o1' }, actions: [{ actionId: 'a1', kind: 'click', basedOn: 'o1', point: { x: 1, y: 2 } }], calls: [] } };
  const decision = async summary => new LayeredRiskGuard().evaluate({ ...base, candidate: { ...base.candidate, calls: [{ id: 'c1', name: 'click', arguments: { x: 1, y: 2 }, declaredEffect: { effects: ['navigate'], target: 'Confirm payment', summary } }] } }, signal);
  assert.equal((await decision('Click Confirm payment')).decision, 'require_approval');
  assert.equal((await decision('View the bill then click Confirm payment')).decision, 'allow');
});

test('F07: finished snapshot does not make start settle while Computer.close is pending', async () => {
  let release;
  let entered;
  const closing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness([finish()], 'off', async () => { entered(); await gate; });
  let settled = false;
  const running = h.controller.start('Cleanup fixture').then(value => { settled = true; return value; });
  await closing;
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.controller.getSnapshot().status, 'finished');
    assert.equal(settled, false);
  } finally { release(); await running; }
});

test('R01: unknown declaration bypasses mandatory protected-input route when reviewer returns low', async () => {
  const call = { id: 'protected', name: 'type', arguments: { text: 'password=SYNTHETIC_ONLY' }, declaredEffect: { effects: ['local_edit'], target: 'input', summary: 'Fill the field' } };
  const context = { runId: 'audit-run', goal: 'Fill the field', recentUserInputs: [], snapshot: initialRunSnapshot('audit-run'), candidate: { session, decisionObservation: { id: 'o1' }, calls: [call], actions: [{ actionId: 'a1', kind: 'type', text: call.arguments.text, basedOn: 'o1' }] } };
  const options = { assessor: new ScriptedRiskAssessor({ effects: ['local_edit'], alignment: 'aligned', evidence: 'Synthetic low-risk review' }) };
  assert.equal((await new LayeredRiskGuard(options).evaluate(context, signal)).decision, 'require_approval');
  const ambiguous = { ...context, candidate: { ...context.candidate, calls: [{ ...call, declaredEffect: { ...call.declaredEffect, effects: ['unknown'] } }] } };
  const result = await new LayeredRiskGuard(options).evaluate(ambiguous, signal);
  assert.equal(result.decision, 'allow');
  assert.equal(result.path, 'model');
});

test('F12: real renderer preserves untrusted terminal control sequences', () => {
  const output = buildTuiFrame(initialRunSnapshot('audit-run'), [], 'hello\u001b[2Jworld', { provider: 'fake', computer: 'fake', output: 'runs/synthetic' }, { editMode: false, input: '', notice: '' });
  assert.equal(output.includes('\u001b[2J'), true);
});

test('F06/F11: exact compiled logger projection retains native text but misses flat calls', async () => {
  // CLI starts main on import: extract only its unmodified pure diagnostic functions.
  // This is source-level evaluation, not a complete HTTP/CLI integration test.
  const source = await readFile(new URL('../../apps/cli/dist/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function summarizeProviderResponse(');
  const end = source.indexOf('async function loadEnvFile(', start);
  assert.ok(start >= 0 && end > start);
  const summarize = vm.runInNewContext(`${source.slice(start, end)}; summarizeProviderResponse`);
  const sentinel = 'SYNTHETIC_PRIVATE_INPUT';
  const native = summarize({ choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'type', arguments: JSON.stringify({ text: sentinel }) } }] } }] });
  assert.equal(JSON.stringify(native).includes(sentinel), true);
  const flat = summarize({ choices: [{ message: { content: JSON.stringify({ calls: [{ id: 'c1', name: 'type', arguments: { text: sentinel } }] }) } }] });
  assert.equal(flat.structuredContent.name, null);
  assert.equal(flat.structuredContent.arguments, null);
  assert.equal(flat.toolCalls.length, 0);
});
