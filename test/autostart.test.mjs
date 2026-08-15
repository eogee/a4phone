// autostart 单元测试：VBS 内容生成、启用/关闭/状态（注入路径，不碰真实启动文件夹）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildVbsContent, enableAutostart, disableAutostart, isAutostartEnabled } from '../src/autostart.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'a4p-auto-'));

test('buildVbsContent：隐藏窗口运行 node a4p.mjs listen', () => {
  const content = buildVbsContent('C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\node_modules\\a4phone\\bin\\a4p.mjs');
  assert.ok(content.includes('WScript.Shell'));
  // shell.Run "..." 0, False → 隐藏窗口、不等待
  assert.ok(content.includes('0, False'), '应以隐藏窗口方式运行');
  assert.ok(content.includes('node.exe'), '应包含 node 路径');
  assert.ok(content.includes('a4p.mjs'), '应包含 a4p 入口路径');
  assert.ok(content.includes('listen'), '应启动续聊守护进程');
});

test('enableAutostart：写入启动文件夹 VBS，isAutostartEnabled 反映状态', () => {
  const dir = tmpDir();
  const vbs = path.join(dir, 'a4phone.vbs');

  const enabled = enableAutostart({ platform: 'win32', nodePath: 'C:\\node.exe', binPath: 'C:\\a4p.mjs', vbsPath: vbs });
  assert.equal(enabled.ok, true);
  assert.ok(fs.existsSync(vbs), '应写入 VBS 文件');
  assert.ok(fs.readFileSync(vbs, 'utf-8').includes('0, False'));
  assert.equal(isAutostartEnabled('win32', vbs), true, '写入后应判定为已开启');

  const disabled = disableAutostart({ platform: 'win32', vbsPath: vbs });
  assert.equal(disabled.ok, true);
  assert.ok(!fs.existsSync(vbs), '应删除 VBS 文件');
  assert.equal(isAutostartEnabled('win32', vbs), false, '删除后应判定为未开启');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('非 Windows 平台：enable 返回明确提示且不写文件', () => {
  const dir = tmpDir();
  const vbs = path.join(dir, 'a4phone.vbs');
  const r = enableAutostart({ platform: 'linux', nodePath: 'node', binPath: 'a4p.mjs', vbsPath: vbs });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('非 Windows'), '应提示非 Windows 平台');
  assert.ok(!fs.existsSync(vbs), '不应写文件');
  assert.equal(isAutostartEnabled('linux', vbs), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
