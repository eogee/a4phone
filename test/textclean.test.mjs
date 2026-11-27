import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, oneLine, stripHostMarkup } from '../src/textclean.mjs';

test('剥离已知宿主注入块，保留块间正文', () => {
  const input = '前文\n<system-reminder>上下文</system-reminder>\n后文';
  assert.equal(stripHostMarkup(input), '前文\n\n后文');
  assert.equal(stripHostMarkup('<USER_INSTRUCTIONS>工作区约定</USER_INSTRUCTIONS>'), '');
});

test('剥离宿主告示行与 user_query 外壳', () => {
  const input = 'Caveat: 本地命令生成\n\n<user_query>真实提问</user_query>';
  assert.equal(stripHostMarkup(input), '真实提问');
  assert.equal(stripHostMarkup('<user_query>只有开壳没有闭壳'), '只有开壳没有闭壳');
});

test('跳过整条后台任务通知', () => {
  const input = '<task-notification>\n<task-id>1</task-id>\n<summary>done</summary>\n</task-notification>\n\n'
    + 'Use the TaskOutput tool with task_id="1" to retrieve unread output.\n'
    + '[SYSTEM NOTIFICATION - NOT USER INPUT] This is an automated event.';
  assert.equal(stripHostMarkup(input), '');
});

test('附件与技能占位符转换为可读标题', () => {
  const input = '@image#1:"局部截取_20261025_180000.png" '
    + '@skill:"C:\\proj\\.workbuddy\\skills\\video-cover\\SKILL.md" '
    + '@long-text:"开工 M5(B6 主..." <long_text_quote>数千字历史摘要</long_text_quote>继续吧\n'
    + '<image_local_path>C:\\Users\\me\\shot.png</image_local_path>';
  assert.equal(cleanTitle(input), 'video-cover 开工 M5(B6 主 继续吧');
});

test('用户自己贴的 HTML/XML 不被误删', () => {
  const input = '<html><body>帮我看看这个页面布局</body></html>';
  assert.equal(cleanTitle(input), input);
});

test('标题压成单行并按字符截断', () => {
  assert.equal(oneLine('  第一行\n第二行\t内容  '), '第一行 第二行 内容');
  const out = oneLine('字'.repeat(200));
  assert.equal(out.length, 83);
  assert.ok(out.endsWith('...'));
});

test('cleanTitle 幂等且空标题保持为空', () => {
  const once = cleanTitle('@image#1:shot.png 修一下登录页');
  assert.equal(once, '修一下登录页');
  assert.equal(cleanTitle(once), once);
  assert.equal(cleanTitle('<system-reminder>只有上下文</system-reminder>'), '');
});
