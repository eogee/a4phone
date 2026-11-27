const INJECTED_TAG_BLOCKS = [
  'system-reminder',
  'user_instructions',
  'environment_context',
  'INSTRUCTIONS',
  'task-notification',
  'long_text_quote',
  'image_local_path',
];

const INJECTED_LINE_PATTERNS = [
  /^# AGENTS\.md instructions[^\n]*(?:\n|$)/gm,
  /^Caveat:[^\n]*(?:\n|$)/gm,
  /^Use the TaskOutput tool with task_id=[^\n]*(?:\n|$)/gm,
  /^\[SYSTEM NOTIFICATION - NOT USER INPUT\][^\n]*(?:\n|$)/gm,
];

const USER_QUERY_SHELL = /<\/?user_query\b[^>]*>/gi;
const IMAGE_TOKEN = /@image#\d+\s*:\s*(?:"[^"\n]*"|[^\s"\n]+)\s*/gi;
const LONG_TEXT_TOKEN = /@long[-_]text\s*:\s*"([^"\n]*)"\s*/gi;
const SKILL_TOKEN = /@skill\s*:\s*"([^"\n]*)"\s*/gi;
const QUOTED_REF = /@"[^"\n]*"\s*/gi;

function skillName(value) {
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === 'skill.md') parts.pop();
  return parts.at(-1) || '';
}

export function stripHostMarkup(text) {
  let value = String(text ?? '');
  // Only strip known host tags so user-supplied HTML/XML survives.
  for (const tag of INJECTED_TAG_BLOCKS) {
    value = value.replace(new RegExp(`<${tag}\\b[^>]*>.*?</${tag}>`, 'gis'), '');
  }
  for (const pattern of INJECTED_LINE_PATTERNS) value = value.replace(pattern, '');
  value = value.replace(USER_QUERY_SHELL, '');
  value = value.replace(LONG_TEXT_TOKEN, (_, preview) => preview.replace(/[.．…]+$/, '') + ' ');
  value = value.replace(SKILL_TOKEN, (_, value) => skillName(value) + ' ');
  value = value.replace(IMAGE_TOKEN, '');
  return value.replace(QUOTED_REF, '').trim();
}

export function oneLine(text, maxLength = 80) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + '...' : cleaned;
}

export function cleanTitle(text, maxLength = 80) {
  return oneLine(stripHostMarkup(text), maxLength);
}
