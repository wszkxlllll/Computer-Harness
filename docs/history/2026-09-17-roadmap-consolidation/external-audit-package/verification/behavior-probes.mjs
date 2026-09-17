/**
 * Function-level reproductions for Computer-Harness@39ff27f9a4ef5431450df6991793403ec890f993.
 * These are extracted algorithms with TypeScript types removed, NOT an import of
 * the repository, NOT its Vitest suite, and NOT a desktop/Provider integration test.
 * Passing means that the observed problematic behavior was reproduced.
 * No network, credentials, desktop control or real private input are used.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// packages/context/src/index.ts: fitEventsToTokenBudget / estimateEventTokens
function fitEventsToTokenBudget(events, maxTokens) {
  const retained = [...events];
  while (retained.length > 1 && estimateEventTokens(retained) > maxTokens) {
    const firstResponse = retained.findIndex((event) => event.type === 'model.response.received');
    if (firstResponse < 0) {
      retained.shift();
      continue;
    }
    const nextResponse = retained.slice(firstResponse + 1).findIndex((event) => event.type === 'model.response.received');
    const end = nextResponse < 0 ? retained.length : firstResponse + 1 + nextResponse;
    retained.splice(0, end);
  }
  return retained;
}
function estimateEventTokens(events) {
  return Math.ceil(events.reduce((total, event) => total + JSON.stringify(event).length, 0) / 4);
}

// packages/runtime/src/run-controller.ts: validateMemoryTaskLinks
// The instance fields this.planningEnabled / this.snapshot are represented by arguments.
function validateMemoryTaskLinks(mutation, planningEnabled, snapshot) {
  const relatedTaskIds = mutation.operation === 'upsert_fact'
    ? mutation.fact.relatedTaskIds
    : mutation.operation === 'upsert_entity' ? mutation.entity.relatedTaskIds : undefined;
  if (relatedTaskIds === undefined || relatedTaskIds.length === 0) return;
  if (!planningEnabled) throw new Error('Memory relatedTaskIds require Planning to be enabled');
  const known = new Set(snapshot.plan.tasks.map((task) => task.id));
  const unknown = relatedTaskIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Memory relatedTaskIds reference unknown task(s): ${unknown.join(', ')}`);
}

// packages/risk-guard/src/index.ts: scanDeclarationText
function scanDeclarationText(declarations) {
  const matches = [
    { pattern: /(pay|purchase|transfer|checkout|付款|支付|购买|转账|结算)/iu, category: 'financial' },
    { pattern: /(send|publish|post|submit|发送|发布|提交)/iu, category: 'external_commitment' },
    { pattern: /(permanent(?:ly)? delete|erase|wipe|永久删除|彻底删除|清空)/iu, category: 'destructive' },
    { pattern: /(password|permission|privacy|credential|密码|权限|隐私|凭据)/iu, category: 'privacy_account' },
  ];
  const categories = [];
  for (const declaration of declarations) {
    const text = `${declaration.target}\n${declaration.summary}`.toLowerCase();
    const descriptiveContext = /(view|show|inspect|history|record|help|write|type|draft|quote|mention|查看|浏览|记录|历史|帮助|写入|输入|草稿|引用|讨论)/iu.test(text);
    if (descriptiveContext && (declaration.effects.includes('navigate') || declaration.effects.includes('local_edit'))) continue;
    categories.push(...matches.filter((item) => item.pattern.test(text)).map((item) => item.category));
  }
  if (categories.length === 0) return undefined;
  return { code: 'undeclared_high_impact_text', reason: 'The declared target or summary contains an undeclared high-impact signal.', categories: [...new Set(categories)] };
}

// apps/cli/src/index.ts: native tool-call projection inside summarizeProviderResponse.
// This reproduces only that exact projection branch, not the complete HTTP client.
function nativeToolCallSummary(message) {
  return message !== undefined && Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => {
        const record = isPlainRecord(call) ? call : undefined;
        const fn = record !== undefined && isPlainRecord(record.function) ? record.function : undefined;
        return {
          id: record !== undefined && typeof record.id === 'string' ? record.id : null,
          type: record !== undefined && typeof record.type === 'string' ? record.type : null,
          name: fn !== undefined && typeof fn.name === 'string' ? fn.name : null,
          arguments: fn !== undefined && typeof fn.arguments === 'string' ? fn.arguments : null,
        };
      })
    : [];
}
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('F02: a user correction is removed by the token-budget pruning stage', () => {
  const events = [
    { type: 'user.input.received', sequence: 1, text: 'Do not submit the form.' },
    { type: 'model.response.received', sequence: 2, turn: { type: 'tool_calls', calls: [{ id: 'old-call', name: 'click', arguments: { x: 10, y: 20 } }], assistantText: 'x'.repeat(4000) } },
    { type: 'tool.call.completed', sequence: 3, result: { callId: 'old-call', status: 'completed', output: { ok: true } } },
    { type: 'model.response.received', sequence: 4, turn: { type: 'tool_calls', calls: [{ id: 'new-call', name: 'click', arguments: { x: 30, y: 40 } }] } },
    { type: 'tool.call.completed', sequence: 5, result: { callId: 'new-call', status: 'completed', output: { ok: true } } },
  ];
  const result = fitEventsToTokenBudget(events, 200);
  assert.equal(result.length, 2);
  assert.equal(result[0].turn.calls[0].id, 'new-call');
  assert.equal(result[1].result.callId, 'new-call');
  assert.equal(result.some(event => event.type === 'user.input.received'), false);
});

test('F05: a single oversized event survives the advertised pruning limit', () => {
  const event = { type: 'user.input.received', text: 'x'.repeat(8000) };
  const result = fitEventsToTokenBudget([event], 100);
  assert.equal(result.length, 1);
  assert.ok(estimateEventTokens(result) > 100);
});

test('F03: unknown task link is rejected for upsert, but accepted for replacement', () => {
  const snapshot = { plan: { tasks: [{ id: 't1' }] } };
  const fact = { relatedTaskIds: ['not-a-real-task'] };
  assert.throws(() => validateMemoryTaskLinks({ operation: 'upsert_fact', fact }, true, snapshot), /unknown task/);
  assert.doesNotThrow(() => validateMemoryTaskLinks({ operation: 'supersede_fact', factId: 'm1', replacement: fact }, true, snapshot));
});

test('F03: replacement also bypasses the Planning-disabled guard', () => {
  const snapshot = { plan: { tasks: [] } };
  const fact = { relatedTaskIds: ['t1'] };
  assert.throws(() => validateMemoryTaskLinks({ operation: 'upsert_fact', fact }, false, snapshot), /Planning to be enabled/);
  assert.doesNotThrow(() => validateMemoryTaskLinks({ operation: 'supersede_fact', factId: 'm1', replacement: fact }, false, snapshot));
});

test('F08: descriptive wording suppresses a financial keyword escalation', () => {
  const effect = { effects: ['navigate'], target: '确认付款', summary: '点击确认付款' };
  assert.deepEqual(scanDeclarationText([effect])?.categories, ['financial']);
  assert.equal(scanDeclarationText([{ ...effect, summary: '查看账单后点击确认付款' }]), undefined);
});

test('F06: native-call diagnostic projection preserves synthetic private text', () => {
  const sentinel = 'AUDIT_SYNTHETIC_PRIVATE_INPUT_NOT_A_REAL_SECRET';
  const message = { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'type', arguments: JSON.stringify({ text: sentinel }) } }] };
  assert.equal(JSON.stringify(nativeToolCallSummary(message)).includes(sentinel), true);
});
