/**
 * 【一時ツール】送信済みメールログから消えた予約行を復元する
 *
 * 背景: 2026-06-18 朝、フィルタ適用中の行削除で予約行が巻き添え削除された。
 * 送信済みの確認/変更/キャンセルメールには予約番号・トークン等が残っているため、
 * そこからシートに存在しない予約を再構築する。
 *
 * 使い方（必ずこの順で）:
 *  1. restoreFromMailDryRun() を実行
 *     → スプレッドシートに「RestoreReport」タブができ、復元候補が一覧される。
 *       予約シート本体には一切触らない。
 *  2. RestoreReport の内容を目視確認
 *  3. restoreFromMailExecute() を実行
 *     → 候補行を Reservations の末尾に追加する（既存行は変更しない）。
 *       2回実行しても既に追加済みのIDはスキップされる（重複しない）。
 *
 * 補足:
 * - ステータスは「キャンセルメールの有無」「変更メールの変更前情報」から自動判定
 * - きっかけ(source)・電話・カレンダーイベントIDは、残っていればカレンダーの
 *   予定説明欄から補完する
 * - 来店日が過去の行は reminderSent / thankYouSent を TRUE で復元し、
 *   今さらリマインダー等が飛ばないようにする
 * - 復元完了後、このファイルは削除してよい
 */

const RESTORE_SEARCH_AFTER = '2026/04/01'; // この日以降の送信メールを走査

function restoreFromMailDryRun() {
  restoreFromMail_(false);
}

function restoreFromMailExecute() {
  restoreFromMail_(true);
}

function restoreFromMail_(execute) {
  const sheet = getReservationsSheet();

  // 既存の予約IDを収集
  const existingIds = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(r => {
      if (r[0]) existingIds.add(String(r[0]));
    });
  }

  // メール走査
  const confirmations = collectMailReservations_('【燕テラス】ご予約を承りました', false);
  const changes = collectMailReservations_('【燕テラス】ご予約内容を変更しました', true);
  const cancels = collectCancellations_();

  // 変更メールの「変更前」情報（旧予約を status=changed と判定するための照合キー）
  const changedOldKeys = new Set();
  changes.forEach(c => {
    if (c.oldKey) changedOldKeys.add(c.oldKey);
  });

  // シートに無い予約を抽出
  const seen = new Set();
  const missing = [];
  confirmations.concat(changes).forEach(m => {
    if (!m.reservationId || seen.has(m.reservationId)) return;
    seen.add(m.reservationId);
    if (existingIds.has(m.reservationId)) return;

    let status = STATUS.CONFIRMED;
    let note = '';
    if (cancels.has(m.reservationId)) {
      status = STATUS.CANCELLED;
      note = 'キャンセルメールあり（' + cancels.get(m.reservationId) + ' 送信）';
    } else {
      const key = [m.to, m.reservationDate, m.slot, m.totalPeople].join('|');
      if (changedOldKeys.has(key)) {
        status = STATUS.CHANGED;
        note = '後日変更された予約（変更前レコードとして復元）';
      }
    }
    m.status = status;
    m.note = note;
    tryRecoverFromCalendar_(m);
    missing.push(m);
  });

  missing.sort((a, b) => a.reservationId < b.reservationId ? -1 : 1);

  writeRestoreReport_(missing, execute);

  // 実行モード: シート末尾に追加
  if (execute) {
    const todayStr = formatDate(new Date());
    const phoneCol = RESERVATION_HEADERS.indexOf('phone') + 1;
    missing.forEach(m => {
      const isPast = m.reservationDate < todayStr;
      const isToday = m.reservationDate === todayStr;
      const reservation = {
        reservationId: m.reservationId,
        createdAt: m.createdAt,
        status: m.status,
        reservationDate: m.reservationDate,
        slot: m.slot,
        slotLabel: m.slotLabel,
        name: m.name,
        phone: m.phone,
        email: m.to,
        adults: m.adults,
        children: m.children,
        schoolChildren: '', // 6/18以前の予約は内訳導入前なので空欄＝不明でOK
        preschoolChildren: '',
        totalPeople: m.totalPeople,
        source: m.source,
        notes: m.notes,
        cancelToken: m.token,
        reminderSent: (isPast || isToday), // 過去・当日分は再送しない
        calendarEventId: m.calendarEventId,
        updatedAt: new Date(),
        thankYouSent: isPast, // 過去分は今さらサンキューメールを送らない
      };
      const row = RESERVATION_HEADERS.map(h => (h in reservation) ? reservation[h] : '');
      sheet.appendRow(row);
      if (phoneCol > 0 && reservation.phone) {
        sheet.getRange(sheet.getLastRow(), phoneCol).setNumberFormat('@').setValue(reservation.phone);
      }
    });
  }

  console.log((execute ? '【復元実行】' : '【ドライラン】') + ' 対象 ' + missing.length +
    ' 件。詳細はスプレッドシートの RestoreReport タブを確認してください。');
}

/**
 * 指定件名の送信済みメールを走査し、本文から予約情報を再構築する
 * @param {boolean} isChangeMail 変更完了メールか（変更前ブロックの解釈が必要）
 */
function collectMailReservations_(subject, isChangeMail) {
  const query = 'in:sent subject:"' + subject + '" after:' + RESTORE_SEARCH_AFTER;
  const out = [];
  let start = 0;
  while (true) {
    const threads = GmailApp.search(query, start, 100);
    if (threads.length === 0) break;
    threads.forEach(thread => {
      thread.getMessages().forEach(msg => {
        try {
          const parsed = parseReservationMail_(msg, isChangeMail);
          if (parsed) out.push(parsed);
        } catch (e) {
          console.warn('メール解析失敗（スキップ）:', msg.getSubject(), e);
        }
      });
    });
    if (threads.length < 100) break;
    start += threads.length;
  }
  return out;
}

function parseReservationMail_(msg, isChangeMail) {
  const html = msg.getBody();

  const idMatch = html.match(/R\d{18}/);
  if (!idMatch) return null; // 返信メール等、予約番号が無いものはスキップ
  const reservationId = idMatch[0];

  // 予約IDに作成日時が埋め込まれている: R + yyyyMMddHHmmss + 乱数4桁
  const t = reservationId.match(/^R(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{4}$/);
  const createdAt = new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3]),
    Number(t[4]), Number(t[5]), Number(t[6]));

  // キャンセルURLからトークン
  const tokenMatch = html.match(/token=([A-Za-z0-9]{32})/);
  const token = tokenMatch ? tokenMatch[1] : '';

  // 宛先（お客様メールアドレス）
  const toMatch = String(msg.getTo()).match(/[\w.+\-]+@[\w.\-]+/);
  const to = toMatch ? toMatch[0].toLowerCase() : '';

  // 宛名（テンプレートの greeting 部分）
  let name = '';
  const nameMatch = html.match(/class="greeting"[^>]*>\s*([\s\S]*?)\s*様/);
  if (nameMatch) name = unescapeHtmlEntities_(nameMatch[1]).trim();

  // 本文をテキスト化して項目抽出
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');

  // 来店日（変更メールは「変更前」「変更後」の2つ出る → 最後が現予約）
  const dates = matchAll_(text, /(\d{4})年(\d{1,2})月(\d{1,2})日/g).map(m2 =>
    m2[1] + '-' + padZero_(m2[2]) + '-' + padZero_(m2[3]));
  if (dates.length === 0) return null;
  const reservationDate = dates[dates.length - 1];

  // 時間帯ラベル → slot id
  const slotLabels = matchAll_(text, /(\d{1,2}:\d{2}〜)/g).map(m2 => m2[1]);
  const slotLabel = slotLabels.length ? slotLabels[slotLabels.length - 1] : '';
  const slotDef = CONFIG.SLOTS.find(s => s.label === slotLabel);
  const slot = slotDef ? slotDef.id : '';

  // 人数（合計は複数出うる → 最後が現予約。大人/お子様の内訳は1回のみ）
  const totals = matchAll_(text, /合計\s*(\d+)\s*名/g).map(m2 => Number(m2[1]));
  const totalPeople = totals.length ? totals[totals.length - 1] : 0;
  const adultChild = text.match(/大人\s*(\d+)\s*\/\s*お子様\s*(\d+)/);
  const adults = adultChild ? Number(adultChild[1]) : totalPeople;
  const children = adultChild ? Number(adultChild[2]) : 0;

  // 電話・備考（確認メールのみ。変更メールには無い → カレンダーから補完を試みる）
  const phoneMatch = text.match(/お電話\s*(\S+)/);
  const phone = phoneMatch ? unescapeHtmlEntities_(phoneMatch[1]).trim() : '';
  const notesMatch = text.match(/備考\s*([\s\S]*?)\s*予約番号/);
  const notes = notesMatch ? unescapeHtmlEntities_(notesMatch[1]).trim() : '';

  const result = {
    reservationId: reservationId,
    createdAt: createdAt,
    reservationDate: reservationDate,
    slot: slot,
    slotLabel: slotLabel,
    name: name,
    phone: phone,
    to: to,
    adults: adults,
    children: children,
    totalPeople: totalPeople,
    notes: notes,
    token: token,
    source: '',
    calendarEventId: '',
    mailDate: msg.getDate(),
    oldKey: '',
  };

  // 変更メールの場合、「変更前」ブロック（最初の日付/時間/合計）から旧予約の照合キーを作る
  if (isChangeMail && dates.length >= 2 && slotLabels.length >= 2 && totals.length >= 2) {
    const oldSlotDef = CONFIG.SLOTS.find(s => s.label === slotLabels[0]);
    result.oldKey = [to, dates[0], oldSlotDef ? oldSlotDef.id : '', totals[0]].join('|');
  }

  return result;
}

/**
 * キャンセル完了メールを走査し、予約ID → キャンセルメール送信日 のマップを返す
 */
function collectCancellations_() {
  const map = new Map();
  const query = 'in:sent subject:"【燕テラス】ご予約のキャンセルを承りました" after:' + RESTORE_SEARCH_AFTER;
  let start = 0;
  while (true) {
    const threads = GmailApp.search(query, start, 100);
    if (threads.length === 0) break;
    threads.forEach(thread => {
      thread.getMessages().forEach(msg => {
        const idMatch = msg.getBody().match(/R\d{18}/);
        if (idMatch && !map.has(idMatch[0])) {
          map.set(idMatch[0], Utilities.formatDate(msg.getDate(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'));
        }
      });
    });
    if (threads.length < 100) break;
    start += threads.length;
  }
  return map;
}

/**
 * カレンダーの予定説明欄（予約ID・電話・きっかけ・備考が書いてある）から情報を補完する。
 * 予定が既に削除されている場合は何もしない。
 */
function tryRecoverFromCalendar_(m) {
  try {
    const calId = PropertiesService.getScriptProperties().getProperty('RESERVATION_CALENDAR_ID') || CONFIG.RESERVATION_CALENDAR_ID;
    if (!calId || !m.reservationDate) return;
    const cal = CalendarApp.getCalendarById(calId);
    if (!cal) return;
    const events = cal.getEventsForDay(parseDate(m.reservationDate));
    for (let i = 0; i < events.length; i++) {
      const desc = events[i].getDescription() || '';
      if (desc.indexOf(m.reservationId) === -1) continue;
      m.calendarEventId = events[i].getId();
      const src = desc.match(/きっかけ: ?(.*)/);
      if (src) m.source = src[1].trim();
      const ph = desc.match(/電話: ?(.*)/);
      if (ph && !m.phone) m.phone = ph[1].trim();
      const nt = desc.match(/備考: ?([\s\S]*)/);
      if (nt && !m.notes) m.notes = nt[1].trim();
      return;
    }
  } catch (e) {
    console.warn('カレンダー照合失敗（スキップ）:', m.reservationId, e);
  }
}

/**
 * 復元候補を RestoreReport タブに書き出す（毎回作り直し）
 */
function writeRestoreReport_(missing, execute) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName('RestoreReport');
  if (!sheet) {
    sheet = ss.insertSheet('RestoreReport');
  } else {
    sheet.clear();
  }

  const headers = ['予約ID', '予約が入った日時', '復元ステータス', '来店日', '時間', 'お名前',
    '電話', 'メール', '大人', '子ども', '合計', 'きっかけ', '備考',
    'トークン', 'カレンダー照合', '判定メモ'];
  const rows = missing.map(m => [
    m.reservationId,
    Utilities.formatDate(m.createdAt, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    m.status,
    m.reservationDate,
    m.slotLabel,
    m.name,
    m.phone,
    m.to,
    m.adults,
    m.children,
    m.totalPeople,
    m.source,
    m.notes,
    m.token ? '復元OK' : '× 取得できず',
    m.calendarEventId ? '一致あり（source等を補完）' : '予定なし',
    m.note,
  ]);

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  const modeLabel = execute
    ? '復元実行済み: 上記 ' + rows.length + ' 件を Reservations 末尾に追加しました'
    : 'ドライラン（まだ何も追加していません）: 内容確認後 restoreFromMailExecute を実行してください';
  sheet.getRange(rows.length + 3, 1).setValue(
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm') + ' ' + modeLabel);
  sheet.autoResizeColumns(1, headers.length);
}

function unescapeHtmlEntities_(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function matchAll_(text, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    out.push(m);
  }
  return out;
}

function padZero_(n) {
  return String(n).padStart(2, '0');
}
