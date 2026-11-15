import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseReport, isJapanese, findCharacter, applyReport, buildComment } from '../scripts/apply-report.js';

/** 依 Issue Form 的輸出格式組出內文；沒給的欄位為 `_No response_`。 */
function body(fields = {}) {
  const titles = [
    '角色名稱（中文）', '角色名稱（日文）', '性格', '屬性', '正確選項',
    '選項文字', '緣份（遣散後的能力加成）', '截圖（選填）', '備註',
  ];
  return titles.map((title) => `### ${title}\n\n${fields[title] ?? '_No response_'}`).join('\n\n');
}

/** 建立測試用角色。 */
function make(id, zh, ja, overrides = {}) {
  return {
    id,
    no: 1,
    name: { zh, ja },
    avatar: null,
    alignment: 'good',
    element: 'fire',
    rarity: 'named',
    dialogue: { option: null, answer: { zh: null, ja: null } },
    bond: null,
    contributors: [],
    verified: true,
    ...overrides,
  };
}

const iroha = make('iroha', '五郎八', 'イロハ');
const zelf = make('zelf', '哲魯夫', 'ゼルフ', {
  alignment: 'evil', element: 'dark', bond: 'str', verified: false, contributors: ['渢雨嵐'],
  dialogue: { option: 2, answer: { zh: '留下名聲之類的', ja: null } },
});
const ALL = [iroha, zelf];

const irohaReport = {
  '角色名稱（中文）': '五郎八', '角色名稱（日文）': 'イロハ',
  性格: '善', 屬性: '火', 正確選項: '2', 選項文字: '這樣就不會失去夥伴了',
};
const apply = (fields) => applyReport(ALL, parseReport(body(fields)));

describe('parseReport', () => {
  test('讀出各欄位，_No response_ 視為沒填', () => {
    const r = parseReport(body({ ...irohaReport, 備註: '來源：自己測的\n回報者：小明' }));
    assert.deepEqual(r, {
      nameZh: '五郎八', nameJa: 'イロハ', alignment: '善', element: '火',
      option: '2', answer: '這樣就不會失去夥伴了', bond: '', contributor: '小明',
    });
  });

  test('接受 CRLF 換行與半形冒號的回報者', () => {
    const r = parseReport(body({ ...irohaReport, 備註: '回報者: Amy' }).replace(/\n/g, '\r\n'));
    assert.equal(r.option, '2');
    assert.equal(r.contributor, 'Amy');
  });

  test('空內文不會丟錯', () => {
    assert.equal(parseReport(null).nameZh, '');
  });
});

describe('isJapanese', () => {
  test('含假名才算日文', () => {
    assert.equal(isJapanese('今を楽しめ'), true);
    assert.equal(isJapanese('得到上帝寬恕'), false);
  });
});

describe('findCharacter', () => {
  test('用日文名或中文名找到角色', () => {
    assert.equal(findCharacter(ALL, { nameZh: '', nameJa: 'イロハ' }).character, iroha);
    assert.equal(findCharacter(ALL, { nameZh: '哲魯夫', nameJa: '' }).character, zelf);
  });

  test('中文欄填日文名也找得到', () => {
    assert.equal(findCharacter(ALL, { nameZh: 'ゼルフ', nameJa: '' }).character, zelf);
  });

  test('中日文名對到不同角色或都找不到時回傳錯誤', () => {
    assert.match(findCharacter(ALL, { nameZh: '哲魯夫', nameJa: 'イロハ' }).error, /不同角色/);
    assert.match(findCharacter(ALL, { nameZh: '新角色', nameJa: '' }).error, /找不到/);
  });
});

describe('applyReport', () => {
  test('套用選項與中文文字，不修改原本的陣列', () => {
    const result = apply(irohaReport);
    assert.equal(result.status, 'applied');
    assert.equal(result.name, '五郎八');
    const updated = result.characters.find((c) => c.id === 'iroha');
    assert.deepEqual(updated.dialogue, { option: 2, answer: { zh: '這樣就不會失去夥伴了', ja: null } });
    assert.equal(iroha.dialogue.option, null);
    assert.equal(result.characters[1], zelf);
  });

  test('日文選項文字放進 answer.ja', () => {
    const result = apply({ ...irohaReport, 選項文字: '今を楽しめ' });
    assert.deepEqual(result.characters[0].dialogue.answer, { zh: null, ja: '今を楽しめ' });
  });

  test('加入回報者與緣份，重複的回報者不再加', () => {
    const result = apply({ ...irohaReport, '緣份（遣散後的能力加成）': '靈', 備註: '回報者：小明' });
    assert.equal(result.characters[0].bond, 'spi');
    assert.deepEqual(result.characters[0].contributors, ['小明']);

    const again = applyReport(result.characters, parseReport(body({ ...irohaReport, 備註: '回報者：小明' })));
    assert.equal(again.status, 'unchanged');
  });

  test('明確選項加上文字會取消待確認', () => {
    const result = apply({ '角色名稱（中文）': '哲魯夫', 性格: '惡', 屬性: '暗', 正確選項: '2' });
    assert.equal(result.status, 'applied');
    assert.equal(result.characters[1].verified, true);
  });

  test('「不確定」只更新文字，不動選項與待確認', () => {
    const result = apply({ '角色名稱（中文）': '哲魯夫', 性格: '惡', 屬性: '暗', 正確選項: '不確定', 選項文字: '留下名聲' });
    assert.equal(result.status, 'applied');
    assert.equal(result.characters[1].dialogue.option, 2);
    assert.equal(result.characters[1].dialogue.answer.zh, '留下名聲');
    assert.equal(result.characters[1].verified, false);
  });

  test('性格或屬性與資料不一致時不套用', () => {
    const result = apply({ ...irohaReport, 性格: '惡', 屬性: '水' });
    assert.equal(result.status, 'rejected');
    assert.equal(result.characters, ALL);
    assert.equal(result.errors.length, 2);
  });

  test('「不確定」且沒有文字、缺必填、找不到角色都不套用', () => {
    assert.equal(apply({ ...irohaReport, 正確選項: '不確定', 選項文字: undefined }).status, 'rejected');
    assert.equal(apply({ ...irohaReport, 性格: undefined }).status, 'rejected');
    assert.equal(apply({ ...irohaReport, '角色名稱（中文）': '新角色', '角色名稱（日文）': undefined }).status, 'rejected');
  });

  test('緣份與既有資料衝突、文字過長或多行時不套用', () => {
    const conflict = apply({ '角色名稱（中文）': '哲魯夫', 性格: '惡', 屬性: '暗', 正確選項: '2', '緣份（遣散後的能力加成）': '智' });
    assert.match(conflict.errors[0], /緣份不一致/);
    assert.equal(apply({ ...irohaReport, 選項文字: '長'.repeat(101) }).status, 'rejected');
    assert.equal(apply({ ...irohaReport, 選項文字: '第一行\n第二行' }).status, 'rejected');
  });
});

describe('buildComment', () => {
  test('依結果產生說明', () => {
    assert.match(buildComment(apply(irohaReport)), /已自動更新「五郎八」[\s\S]*正確選項：（無） → 2/);
    assert.match(buildComment(apply({ ...irohaReport, 性格: '惡' })), /沒有自動套用[\s\S]*性格不一致/);
  });
});
