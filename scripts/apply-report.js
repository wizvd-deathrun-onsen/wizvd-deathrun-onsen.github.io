/**
 * 把一筆「已確認」的社群回報 Issue 套用到 data/characters.json。
 * 由 .github/workflows/approve-report.yml 呼叫；規則對應 CLAUDE.md「更新社群回報」。
 *
 * 只處理能確定的情況；找不到角色、性格／屬性不一致、緣份衝突等一律不改資料，
 * 回傳原因讓 workflow 留言，交給維護者手動處理。
 *
 * 用法：ISSUE_BODY=... node scripts/apply-report.js
 * 選用環境變數 COMMENT_FILE：把要留在 Issue 的說明寫到該路徑。
 * 選用環境變數 ISSUE_AUTHOR：開 Issue 的 GitHub 帳號，備註沒寫回報者時用它當補充者。
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ALIGNMENT = { 善: 'good', 中立: 'neutral', 惡: 'evil' };
const ELEMENT = { 光: 'light', 暗: 'dark', 水: 'water', 火: 'fire', 風: 'wind', 土: 'earth', 無: 'none' };
const BOND = { 力: 'str', 智: 'int', 敏: 'agi', 信: 'fai', 命: 'luk', 靈: 'spi' };
const LABEL_OF = (map, value) => Object.keys(map).find((k) => map[k] === value) ?? '?';

/** 自由文字欄位的長度上限，超過視為異常內容，不自動套用。 */
const MAX_ANSWER = 100;
const MAX_CONTRIBUTOR = 30;

/**
 * 解析 Issue Form 產生的內文。
 * Issue Form 會把每個欄位輸出成「### 標題」加內容，沒填時為 `_No response_`。
 * @param {string} body Issue 內文
 * @returns {{nameZh: string, nameJa: string, alignment: string, element: string,
 *   option: string, answer: string, bond: string, contributor: string}} 各欄位原始文字，沒填為空字串
 */
export function parseReport(body) {
  const sections = new Map();
  for (const part of String(body ?? '').replace(/\r\n/g, '\n').split(/^###[ \t]*/m).slice(1)) {
    const newline = part.indexOf('\n');
    const title = (newline === -1 ? part : part.slice(0, newline)).trim();
    const value = (newline === -1 ? '' : part.slice(newline + 1)).trim();
    sections.set(title, value === '_No response_' ? '' : value);
  }
  const field = (prefix) => {
    for (const [title, value] of sections) if (title.startsWith(prefix)) return value;
    return '';
  };
  // 備註欄的「回報者：暱稱」是希望署名的名稱；沒寫時由 withReporter 改用 GitHub 帳號。
  const reporter = field('備註').match(/回報者\s*[:：]\s*([^\n]+)/);
  return {
    nameZh: field('角色名稱（中文）'),
    nameJa: field('角色名稱（日文）'),
    alignment: field('性格'),
    element: field('屬性'),
    option: field('正確選項'),
    answer: field('選項文字'),
    bond: field('緣份'),
    contributor: reporter ? reporter[1].trim() : '',
  };
}

/**
 * 決定要列為補充者的名稱：備註有「回報者：暱稱」就用它，否則用開 Issue 的 GitHub 帳號名稱。
 * @param {ReturnType<typeof parseReport>} report 解析後的回報
 * @param {string} [author] 開 Issue 的 GitHub 帳號；空字串或沒給時不補
 * @returns {ReturnType<typeof parseReport>} 補上 `contributor` 的新物件
 */
export function withReporter(report, author) {
  return { ...report, contributor: report.contributor || (author ?? '').trim() };
}

/** 含平假名或片假名就當作日文；只有漢字的日文無法分辨，會被當成中文。 */
export function isJapanese(text) {
  return /[぀-ヿ]/.test(text);
}

/**
 * 依回報的名稱找角色：日文名、中文名各自完全比對，兩者指到不同角色時視為找不到。
 * @returns {{character: object|null, error: string|null}}
 */
export function findCharacter(characters, report) {
  const byJa = report.nameJa ? characters.find((c) => c.name.ja === report.nameJa) : null;
  // 表單允許在中文欄填日文名，所以中文欄也比對日文名。
  const byZh = report.nameZh
    ? characters.find((c) => c.name.zh === report.nameZh || c.name.ja === report.nameZh)
    : null;
  if (byJa && byZh && byJa !== byZh) {
    return { character: null, error: `中文名「${report.nameZh}」與日文名「${report.nameJa}」對到不同角色` };
  }
  const character = byJa ?? byZh ?? null;
  if (!character) {
    const names = [report.nameZh, report.nameJa].filter(Boolean).join('／') || '（未填）';
    return { character: null, error: `資料中找不到角色「${names}」（新角色需要先補上基本資料，或名稱與網站譯名不同）` };
  }
  return { character, error: null };
}

/**
 * 把回報套用到角色資料，不修改傳入的陣列。
 * @param {object[]} characters characters.json 的內容
 * @param {ReturnType<typeof parseReport>} report 解析後的回報
 * @returns {{status: 'applied'|'unchanged'|'rejected', characters: object[],
 *   name: string|null, changes: string[], errors: string[]}}
 *   `rejected` 時 `errors` 為不套用的原因；`applied` 時 `changes` 為變更摘要
 */
export function applyReport(characters, report) {
  const rejected = (errors, name = null) => ({ status: 'rejected', characters, name, changes: [], errors });

  const found = findCharacter(characters, report);
  if (!found.character) return rejected([found.error]);
  const original = found.character;
  const name = original.name.zh ?? original.name.ja ?? original.id;
  const errors = [];

  const alignment = ALIGNMENT[report.alignment];
  if (!alignment) errors.push('性格沒填或不是表單選項');
  else if (original.alignment && original.alignment !== alignment) {
    errors.push(`性格不一致：回報「${report.alignment}」，資料為「${LABEL_OF(ALIGNMENT, original.alignment)}」`);
  }
  const element = ELEMENT[report.element];
  if (!element) errors.push('屬性沒填或不是表單選項');
  else if (original.element && original.element !== element) {
    errors.push(`屬性不一致：回報「${report.element}」，資料為「${LABEL_OF(ELEMENT, original.element)}」`);
  }

  const option = ['1', '2', '3'].includes(report.option) ? Number(report.option) : null;
  if (option === null && report.option !== '不確定') errors.push('正確選項沒填或不是表單選項');
  if (option === null && !report.answer) errors.push('正確選項是「不確定」且沒有選項文字，沒有可更新的內容');
  if (report.answer.length > MAX_ANSWER || report.answer.includes('\n')) {
    errors.push(`選項文字超過 ${MAX_ANSWER} 字或有換行`);
  }
  if (report.contributor.length > MAX_CONTRIBUTOR) errors.push(`回報者名稱超過 ${MAX_CONTRIBUTOR} 字`);

  const bond = report.bond ? BOND[report.bond] : null;
  if (report.bond && !bond) errors.push('緣份不是表單選項');
  else if (bond && original.bond && original.bond !== bond) {
    errors.push(`緣份不一致：回報「${report.bond}」，資料為「${LABEL_OF(BOND, original.bond)}」`);
  }
  if (errors.length) return rejected(errors, name);

  const updated = structuredClone(original);
  const changes = [];
  if (option !== null && updated.dialogue.option !== option) {
    changes.push(`正確選項：${updated.dialogue.option ?? '（無）'} → ${option}`);
    updated.dialogue.option = option;
  }
  if (report.answer) {
    const lang = isJapanese(report.answer) ? 'ja' : 'zh';
    if (updated.dialogue.answer[lang] !== report.answer) {
      changes.push(`選項文字（${lang === 'ja' ? '日文' : '中文'}）：${updated.dialogue.answer[lang] ?? '（無）'} → ${report.answer}`);
      updated.dialogue.answer[lang] = report.answer;
    }
  }
  if (bond && !updated.bond) {
    changes.push(`緣份：（無） → ${report.bond}`);
    updated.bond = bond;
  }
  if (report.contributor && !updated.contributors.includes(report.contributor)) {
    changes.push(`補充者：加入 ${report.contributor}`);
    updated.contributors.push(report.contributor);
  }
  // 回報給了明確的選項編號，且套用後有選項文字，才算確認過。
  const hasText = Boolean(updated.dialogue.answer.zh || updated.dialogue.answer.ja);
  if (option !== null && hasText && updated.verified !== true) {
    changes.push('取消「待確認」標記');
    updated.verified = true;
  }

  if (!changes.length) return { status: 'unchanged', characters, name, changes, errors: [] };
  return {
    status: 'applied',
    characters: characters.map((c) => (c === original ? updated : c)),
    name,
    changes,
    errors: [],
  };
}

/** 產生要留在 Issue 的說明文字。 */
export function buildComment(result) {
  const list = (items) => items.map((item) => `- ${item}`).join('\n');
  if (result.status === 'applied') {
    return `已自動更新「${result.name}」的資料，網站約 1–2 分鐘後生效：\n\n${list(result.changes)}`;
  }
  if (result.status === 'unchanged') {
    return `「${result.name}」的資料已經和這筆回報相同，不需要更新。`;
  }
  return `這筆回報沒有自動套用，需要維護者手動處理：\n\n${list(result.errors)}`;
}

function main() {
  const file = new URL('../data/characters.json', import.meta.url);
  const characters = JSON.parse(readFileSync(file, 'utf8'));
  const report = withReporter(parseReport(process.env.ISSUE_BODY), process.env.ISSUE_AUTHOR);
  const result = applyReport(characters, report);
  if (result.status === 'applied') {
    writeFileSync(file, `${JSON.stringify(result.characters, null, 2)}\n`);
  }
  const comment = buildComment(result);
  console.log(comment);
  // 在 GitHub Actions 裡把結果交給後續步驟。留言含回報者輸入的文字，寫成檔案而不放進 output，
  // output 只放來自 characters.json 的名稱，避免內文偽造 output。
  if (process.env.COMMENT_FILE) writeFileSync(process.env.COMMENT_FILE, `${comment}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\nname=${result.name ?? ''}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
