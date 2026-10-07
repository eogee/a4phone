// hook.mjs 单元测试：agent 显示名映射、宿主 hook 超时约束下的作答等待上限
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentName, resolveWaitSeconds, WORKBUDDY_HOOK_TIMEOUT_MS } from '../src/hook.mjs';

test('agentName 映射各宿主显示名', () => {
  assert.equal(agentName('codex'), 'Codex');
  assert.equal(agentName('zcode'), 'ZCode');
  assert.equal(agentName('qoder'), 'Qoder');
  assert.equal(agentName('workbuddy'), 'WorkBuddy');
  // 未识别的一律按基准宿主 Claude Code 显示
  assert.equal(agentName('claude'), 'Claude Code');
  assert.equal(agentName(undefined), 'Claude Code');
});

test('resolveWaitSeconds：WorkBuddy 被收窄到宿主超时之内', () => {
  // 默认配置 60s 恰好等于 WorkBuddy hook 上限，必须收窄留余量，
  // 否则手机还没作答完 hook 就被宿主终止，答案静默失效
  assert.equal(WORKBUDDY_HOOK_TIMEOUT_MS, 60_000);
  const wait = resolveWaitSeconds('workbuddy', { timeout: 60 });
  assert.ok(wait < 60, `实际 ${wait}s，必须小于 hook 上限 60s`);
  assert.equal(wait, 45);
});

test('resolveWaitSeconds：WorkBuddy 已有更短配置时不再放宽', () => {
  // 用户主动把等待调小（更快回退终端）时必须尊重，不被最小值逻辑放大
  assert.equal(resolveWaitSeconds('workbuddy', { timeout: 20 }), 20);
  // 极小值有下限，避免完全无法作答
  assert.equal(resolveWaitSeconds('workbuddy', { timeout: 5 }), 15);
});

test('resolveWaitSeconds：配置很大时仍被宿主上限截断', () => {
  assert.equal(resolveWaitSeconds('workbuddy', { timeout: 300 }), 45);
});

test('resolveWaitSeconds：其余宿主不受影响，沿用配置值', () => {
  for (const agent of ['claude', 'codex', 'zcode', 'qoder']) {
    assert.equal(resolveWaitSeconds(agent, { timeout: 60 }), 60);
    assert.equal(resolveWaitSeconds(agent, { timeout: 300 }), 300, `${agent} 应沿用配置`);
  }
});

test('resolveWaitSeconds：配置缺失时各宿主均有安全默认值', () => {
  assert.equal(resolveWaitSeconds('workbuddy', undefined), 45);
  assert.equal(resolveWaitSeconds('claude', undefined), 60);
});