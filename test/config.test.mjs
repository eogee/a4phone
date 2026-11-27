import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { normalizeConfig } from '../src/config.mjs';

test('normalizeConfig：保留 token 并维持默认值', () => {
  const config = normalizeConfig({ topic: 'a4p-test', server: 'https://ntfy.sh/', token: '  tk_1  ' });
  assert.equal(config.topic, 'a4p-test');
  assert.equal(config.server, 'https://ntfy.sh');
  assert.equal(config.token, 'tk_1');
  assert.equal(config.timeout, 60);
  assert.equal(normalizeConfig().token, '');
});

test('配置读写往返：setup 不会丢失 ntfy 令牌', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-config-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/config.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { saveConfig, loadConfig } = await import(process.env.CONFIG_MODULE_URL);
    saveConfig({ topic: 'a4p-test', server: 'https://ntfy.sh/', token: 'tk_1', timeout: 42 });
    process.stdout.write(JSON.stringify(loadConfig()));
  `], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CONFIG_MODULE_URL: moduleUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.equal(code, 0, stderr);
  const saved = JSON.parse(stdout);
  assert.equal(saved.token, 'tk_1');
  assert.equal(saved.server, 'https://ntfy.sh');
  assert.equal(saved.timeout, 42);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.a4phone', 'config.json'), 'utf8')).token, 'tk_1');
});
