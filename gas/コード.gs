/**
 * 燕テラス 予約管理システム
 * Google Apps Script メインファイル
 */

// ===== 設定 =====
const CONFIG = {
  // スプレッドシート
  SPREADSHEET_ID: '', // ← デプロイ時にスクリプトプロパティで上書き可能
  RESERVATIONS_SHEET: 'Reservations',
  CONFIG_SHEET: 'Config',
  HOLIDAYS_SHEET: 'Holidays', // 休業日を管理するシート（A列:日付, B列:メモ）

  // 営業設定
  SLOTS: [
    { id: 'slot1', label: '11:00〜', startHour: 11, startMinute: 0, endHour: 12, endMinute: 30 },
    { id: 'slot2', label: '13:00〜', startHour: 13, startMinute: 0, endHour: 14, endMinute: 30 },
  ],
  CAPACITY_PER_SLOT: 14,
  BOOKING_WINDOW_DAYS: 30, // お客様が予約可能な日数（今日から何日先まで）
  ADMIN_BOOKING_WINDOW_DAYS: 90, // 管理画面で予約可能な日数（今日から何日先まで）
  MIN_BOOKING_DAYS_AHEAD: 0, // 最短何日先から予約可能か（0 = 当日から / 1 = 翌日から。1 に戻せば当日予約を全面停止できる）
  BOOKING_CUTOFF_MINUTES: 30, // 各枠の開始何分前まで受け付けるか（当日予約の締切）

  // カレンダー（Googleカレンダー: 予約書き込み用）
  RESERVATION_CALENDAR_ID: '', // 予約を書き込むカレンダーID（未設定なら書き込まない）

  // フロントエンド（GitHub Pages）
  FRONTEND_BASE_URL: 'https://tsubame-terrace-owner.github.io/reservation',

  // メール
  STORE_NAME: '燕テラス',
  STORE_EMAIL_FROM_NAME: '燕テラス',
  STORE_REPLY_EMAIL: 'tsubameterrace.nara@gmail.com', // 返信先メールアドレス（スパム判定回避＆お問い合わせ受付用）
  ADMIN_TOKEN: 'tsubame-admin-7Km3PqXz', // 管理画面（手動予約入力）アクセス用トークン
  MAP_IMAGE_DRIVE_ID: '', // Googleドライブ上の道のり案内画像のファイルID
  REMINDER_HOUR_TOMORROW: 19,   // 前日リマインドの送信時刻（翌日の予約が対象）
  REMINDER_HOUR_TODAY: 8,       // 当日リマインドの送信時刻・時（前日に取りこぼした当日予約のフォロー）
  REMINDER_MINUTE_TODAY: 30,    // 当日リマインドの送信時刻・分（GASの仕様で±15分の誤差あり）
  THANKYOU_HOUR: 18,            // サンクスメールの送信時刻・時（来店当日）
  THANKYOU_MINUTE: 30,          // サンクスメールの送信時刻・分（GASの仕様で±15分の誤差あり）

  // クチコミ依頼リンク
  GOOGLE_REVIEW_URL: 'https://g.page/r/CSJC8RVJ5JzxEAE/review',

  // タイムゾーン
  TIMEZONE: 'Asia/Tokyo',
};

// 予約ステータス
const STATUS = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  CHANGED: 'changed', // 変更により古いレコードが無効化された状態
};

// ===========================================================================
// Web エントリーポイント
// ===========================================================================

/**
 * GETリクエスト（ページ表示）
 */
function doGet(e) {
  const page = (e.parameter.page || 'form').toLowerCase();
  const token = e.parameter.token || '';

  try {
    switch (page) {
      case 'cancel':
        return renderCancelPage(token);
      case 'change':
        return renderChangePage(token);
      case 'admin':
        return renderAdminPage(token);
      case 'form':
      default:
        return renderFormPage();
    }
  } catch (err) {
    console.error('doGet error:', err);
    return HtmlService.createHtmlOutput(
      `<h1>エラーが発生しました</h1><p>${escapeHtml(err.message)}</p>`
    ).setTitle('エラー');
  }
}

function renderFormPage() {
  const tpl = HtmlService.createTemplateFromFile('Form');
  tpl.config = {
    slots: CONFIG.SLOTS,
    capacity: CONFIG.CAPACITY_PER_SLOT,
    bookingWindowDays: CONFIG.BOOKING_WINDOW_DAYS,
    // 旧GAS UI（Form.html）は当日予約の受付終了表示に未対応のため翌日以降で固定する。
    // お客様導線は docs/form.html（GitHub Pages）なのでこちらは凍結でよい。
    minDaysAhead: 1,
    storeName: CONFIG.STORE_NAME,
  };
  tpl.userEmail = Session.getActiveUser().getEmail() || '';
  return tpl.evaluate()
    .setTitle(`${CONFIG.STORE_NAME} ご予約`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function renderCancelPage(token) {
  const reservation = findReservationByToken(token);
  const tpl = HtmlService.createTemplateFromFile('Cancel');
  tpl.reservation = reservation;
  tpl.token = token;
  tpl.storeName = CONFIG.STORE_NAME;
  return tpl.evaluate()
    .setTitle(`${CONFIG.STORE_NAME} ご予約キャンセル`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function renderChangePage(token) {
  const reservation = findReservationByToken(token);
  const tpl = HtmlService.createTemplateFromFile('Change');
  tpl.reservation = reservation;
  tpl.token = token;
  tpl.config = {
    slots: CONFIG.SLOTS,
    capacity: CONFIG.CAPACITY_PER_SLOT,
    bookingWindowDays: CONFIG.BOOKING_WINDOW_DAYS,
    // 旧GAS UI（Change.html）は当日予約の受付終了表示に未対応のため翌日以降で固定する
    minDaysAhead: 1,
    storeName: CONFIG.STORE_NAME,
  };
  return tpl.evaluate()
    .setTitle(`${CONFIG.STORE_NAME} ご予約内容の変更`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function renderAdminPage(token) {
  if (!isValidAdminToken(token)) {
    return HtmlService.createHtmlOutput('<h1>アクセス権限がありません</h1><p>正しいトークン付きのURLからアクセスしてください。</p>')
      .setTitle('Forbidden');
  }
  const tpl = HtmlService.createTemplateFromFile('Admin');
  tpl.token = token;
  tpl.config = {
    slots: CONFIG.SLOTS,
    capacity: CONFIG.CAPACITY_PER_SLOT,
    bookingWindowDays: CONFIG.ADMIN_BOOKING_WINDOW_DAYS,
    minDaysAhead: 0, // 管理画面は当日から入力可能
    storeName: CONFIG.STORE_NAME,
  };
  return tpl.evaluate()
    .setTitle(`${CONFIG.STORE_NAME} 手動予約入力`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getAdminToken() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || CONFIG.ADMIN_TOKEN;
}

function isValidAdminToken(token) {
  const expected = getAdminToken();
  return !!expected && token === expected;
}

/**
 * HTMLテンプレートから include(filename) でCSSやJSを読み込むためのヘルパー
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 外部フロント（GitHub Pages の docs/）に渡す公開設定。
 * getConfig / getInitialData / getChangeInitialData で共用する。
 *
 * startHour / startMinute はフロントが受付締切をローカル計算するために必要
 * （ページを開いたまま締切を跨いだ時に、サーバへ問い合わせずボタンを閉じるため）。
 *
 * ※ HtmlService 経路（renderFormPage / renderChangePage / renderAdminPage）は
 *   旧UI向けに別の config を渡しているので、ここには寄せないこと。
 */
function getPublicConfig() {
  return {
    slots: CONFIG.SLOTS.map(s => ({
      id: s.id,
      label: s.label,
      startHour: s.startHour,
      startMinute: s.startMinute,
    })),
    capacity: CONFIG.CAPACITY_PER_SLOT,
    bookingWindowDays: CONFIG.BOOKING_WINDOW_DAYS,
    minDaysAhead: CONFIG.MIN_BOOKING_DAYS_AHEAD,
    cutoffMinutes: CONFIG.BOOKING_CUTOFF_MINUTES,
    storeName: CONFIG.STORE_NAME,
  };
}

/**
 * POSTリクエスト（外部フロントエンド: GitHub Pagesなどからの API 呼び出し用）
 * action パラメータで処理を分岐する。
 */
function doPost(e) {
  try {
    // データ取得：JSON body または URLSearchParams (data=...)
    let data = {};
    if (e.postData && e.postData.contents) {
      try {
        data = JSON.parse(e.postData.contents);
      } catch (parseErr) {
        if (e.parameter && e.parameter.data) {
          data = JSON.parse(e.parameter.data);
        }
      }
    } else if (e.parameter && e.parameter.data) {
      data = JSON.parse(e.parameter.data);
    }

    const action = data.action;
    let result;

    switch (action) {
      case 'getConfig':
        result = {
          success: true,
          config: getPublicConfig(),
          serverNow: Date.now(),
        };
        break;

      case 'getAvailability':
        result = {
          success: true,
          availability: getAvailabilityRange(data.startDate, data.endDate),
          serverNow: Date.now(),
        };
        break;

      case 'getInitialData': {
        // フォーム初回ロード用：config と availability を1回で返す（往復削減）
        const today = new Date();
        const start = new Date(today);
        start.setDate(start.getDate() + CONFIG.MIN_BOOKING_DAYS_AHEAD);
        const end = new Date(today);
        end.setDate(end.getDate() + CONFIG.BOOKING_WINDOW_DAYS);
        const startStr = formatDate(start);
        const endStr = formatDate(end);
        result = {
          success: true,
          config: getPublicConfig(),
          serverNow: Date.now(),
          dateRange: { start: startStr, end: endStr },
          availability: getAvailabilityRange(startStr, endStr),
        };
        break;
      }

      case 'submitReservation':
        result = submitReservation(data.formData || {});
        break;

      case 'findReservation': {
        const r = findReservationByToken(data.token);
        if (!r) {
          result = { success: false, message: '予約情報が見つかりません。' };
        } else {
          result = { success: true, reservation: r };
        }
        break;
      }

      case 'getChangeInitialData': {
        // 変更ページ初回ロード用：reservation + config + availability を1回で返す
        const r = findReservationByToken(data.token);
        if (!r) {
          result = { success: false, message: '予約情報が見つかりません。' };
          break;
        }
        if (r.status !== STATUS.CONFIRMED) {
          result = { success: false, message: 'この予約はすでに無効です。', reservation: r };
          break;
        }
        const today_c = new Date();
        const start_c = new Date(today_c);
        start_c.setDate(start_c.getDate() + CONFIG.MIN_BOOKING_DAYS_AHEAD);
        const end_c = new Date(today_c);
        end_c.setDate(end_c.getDate() + CONFIG.BOOKING_WINDOW_DAYS);
        const startStr_c = formatDate(start_c);
        const endStr_c = formatDate(end_c);
        result = {
          success: true,
          reservation: r,
          config: getPublicConfig(),
          serverNow: Date.now(),
          dateRange: { start: startStr_c, end: endStr_c },
          availability: getAvailabilityRange(startStr_c, endStr_c),
        };
        break;
      }

      case 'submitCancellation':
        result = submitCancellation(data.token);
        break;

      case 'submitChange':
        result = submitChange(data.token, data.formData || {});
        break;

      default:
        result = { success: false, message: 'Unknown action: ' + action };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('doPost error:', err);
    return ContentService
      .createTextOutput(JSON.stringify({
        success: false,
        message: 'doPost error: ' + err.message,
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ===========================================================================
// クライアント（HTML）から呼ばれるAPI
// ===========================================================================

/**
 * 指定期間の空き状況を取得（カレンダーUI用）
 *
 * closed は「受付時間を過ぎた枠」を表す（当日枠が開始30分前を過ぎた場合など）。
 * closed でも available（残席数）はそのまま返す — 空いていれば店頭でご案内できる
 * 可能性があるため、画面には残席を出したままグレーアウトする。
 *
 * @param {string} startDateStr 'YYYY-MM-DD'
 * @param {string} endDateStr   'YYYY-MM-DD'
 * @param {Date|number} [nowOverride] 判定の基準時刻（テスト用の任意引数）
 * @returns {Object} { 'YYYY-MM-DD': { slot1: {booked, available, isHoliday, closed}, slot2: {...} } }
 */
function getAvailabilityRange(startDateStr, endDateStr, nowOverride) {
  const startDate = parseDate(startDateStr);
  const endDate = parseDate(endDateStr);
  // 1レスポンス内で判定時刻を固定する（枠ごとに基準時刻がズレるのを防ぐ）
  const now = nowOverride == null ? new Date() : new Date(nowOverride);

  // 予約集計（集計に要る列だけを読む軽量版。行数が増えても重くなりにくい）
  const reservations = getActiveBookingRows();
  const bookedMap = {}; // 'YYYY-MM-DD|slotId' => 合計人数
  reservations.forEach(r => {
    const key = `${r.reservationDate}|${r.slot}`;
    bookedMap[key] = (bookedMap[key] || 0) + r.totalPeople;
  });

  // 休業日取得
  const holidaySet = getHolidaySet(startDate, endDate);

  const result = {};
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const dateStr = formatDate(cursor);
    const isHoliday = holidaySet.has(dateStr);
    result[dateStr] = {};
    CONFIG.SLOTS.forEach(s => {
      const booked = bookedMap[`${dateStr}|${s.id}`] || 0;
      result[dateStr][s.id] = {
        booked: booked,
        available: Math.max(0, CONFIG.CAPACITY_PER_SLOT - booked),
        isHoliday: isHoliday,
        closed: !isSlotBookable(dateStr, s.id, now),
      };
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

/**
 * 予約作成（フォーム送信時にクライアントから呼ばれる）
 * @param {Object} data フォーム入力
 * @returns {Object} { success, message, reservationId?, cancelUrl? }
 */
function submitReservation(data) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // 10秒待機
  } catch (e) {
    return { success: false, message: '混み合っています。少し時間をおいて再度お試しください。' };
  }

  try {
    // バリデーション
    const validation = validateReservationData(data);
    if (!validation.ok) {
      return { success: false, message: validation.message, code: validation.code };
    }

    // 空き判定
    const totalPeople = Number(data.adults) + extractChildCounts(data).children;
    const availability = getSlotAvailability(data.reservationDate, data.slot);
    if (availability.isHoliday) {
      return { success: false, message: 'この日は休業日です。別の日をお選びください。' };
    }
    if (availability.available < totalPeople) {
      return {
        success: false,
        message: `この枠は残り${availability.available}名です。人数を調整するか別の枠をお選びください。`
      };
    }

    // 二重送信チェック（同じ電話/メール＋同日＋同枠で、直近数分以内に既に予約済みなら新規作成しない）
    const duplicate = findRecentDuplicateReservation(data);
    if (duplicate) {
      return {
        success: true,
        message: 'ご予約を承りました。ご登録のメールアドレスに確認メールをお送りしています。',
        reservationId: duplicate.reservationId,
      };
    }

    // 書き込み
    const reservation = writeReservation(data, totalPeople);

    // カレンダー登録
    try {
      const eventId = createCalendarEvent(reservation);
      if (eventId) updateReservationField(reservation.reservationId, 'calendarEventId', eventId);
    } catch (e) {
      console.warn('Calendar registration failed:', e);
    }

    // メール送信
    try {
      sendConfirmationEmail(reservation);
    } catch (e) {
      console.error('Confirmation email failed:', e);
    }

    // スタッフ通知（拡張ポイント）
    try {
      notifyStaff(reservation, 'created');
    } catch (e) {
      console.warn('Staff notification failed:', e);
    }

    return {
      success: true,
      message: 'ご予約を承りました。ご登録のメールアドレスに確認メールをお送りしています。',
      reservationId: reservation.reservationId,
    };
  } catch (err) {
    console.error('submitReservation error:', err);
    return { success: false, message: 'エラーが発生しました：' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * キャンセル実行
 */
function submitCancellation(token) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, message: '混み合っています。再度お試しください。' };
  }

  try {
    const reservation = findReservationByToken(token);
    if (!reservation) {
      return { success: false, message: '予約情報が見つかりません。' };
    }
    if (reservation.status !== STATUS.CONFIRMED) {
      return { success: false, message: 'この予約はすでにキャンセル済みまたは無効です。' };
    }

    // ステータス更新
    updateReservationField(reservation.reservationId, 'status', STATUS.CANCELLED);
    updateReservationField(reservation.reservationId, 'updatedAt', new Date());

    // カレンダー削除
    if (reservation.calendarEventId) {
      try {
        deleteCalendarEvent(reservation.calendarEventId);
      } catch (e) {
        console.warn('Calendar delete failed:', e);
      }
    }

    // メール送信
    reservation.status = STATUS.CANCELLED;
    try {
      sendCancellationEmail(reservation);
    } catch (e) {
      console.error('Cancellation email failed:', e);
    }

    // スタッフ通知
    try {
      notifyStaff(reservation, 'cancelled');
    } catch (e) {
      console.warn('Staff notification failed:', e);
    }

    return { success: true, message: 'キャンセルを承りました。' };
  } catch (err) {
    console.error('submitCancellation error:', err);
    return { success: false, message: 'エラーが発生しました：' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 変更実行（古い予約をキャンセル扱いにして新しい予約を作成）
 */
function submitChange(token, newData) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, message: '混み合っています。再度お試しください。' };
  }

  try {
    const oldReservation = findReservationByToken(token);
    if (!oldReservation) {
      return { success: false, message: '予約情報が見つかりません。' };
    }
    if (oldReservation.status !== STATUS.CONFIRMED) {
      return { success: false, message: 'この予約は変更できません。' };
    }

    // 新しい予約のバリデーション（当日枠への変更も新規と同じ30分前ルールを適用）
    const validation = validateReservationData(newData);
    if (!validation.ok) {
      return { success: false, message: validation.message, code: validation.code };
    }

    const newTotalPeople = Number(newData.adults) + extractChildCounts(newData).children;

    // 空き判定（ただし自分の旧予約分は差し引く）
    const sameSlot = (oldReservation.reservationDate === newData.reservationDate &&
                      oldReservation.slot === newData.slot);
    const availability = getSlotAvailability(newData.reservationDate, newData.slot);
    if (availability.isHoliday) {
      return { success: false, message: 'この日は休業日です。別の日をお選びください。' };
    }
    const effectiveAvailable = sameSlot
      ? availability.available + oldReservation.totalPeople
      : availability.available;
    if (effectiveAvailable < newTotalPeople) {
      return {
        success: false,
        message: `この枠は残り${Math.max(0, effectiveAvailable)}名です。人数を調整するか別の枠をお選びください。`
      };
    }

    // 旧予約を CHANGED に
    updateReservationField(oldReservation.reservationId, 'status', STATUS.CHANGED);
    updateReservationField(oldReservation.reservationId, 'updatedAt', new Date());
    if (oldReservation.calendarEventId) {
      try {
        deleteCalendarEvent(oldReservation.calendarEventId);
      } catch (e) {
        console.warn('Calendar delete failed:', e);
      }
    }

    // 新予約を作成（メールは「変更完了」扱い）
    // 連絡先は旧予約から引き継ぐ（フォームでも編集可能だが、未入力時のフォールバック）
    const mergedData = Object.assign({}, newData);
    if (!mergedData.email) mergedData.email = oldReservation.email;
    if (!mergedData.name) mergedData.name = oldReservation.name;
    if (!mergedData.phone) mergedData.phone = oldReservation.phone;
    if (!mergedData.source) mergedData.source = oldReservation.source;

    const reservation = writeReservation(mergedData, newTotalPeople);

    // カレンダー登録
    try {
      const eventId = createCalendarEvent(reservation);
      if (eventId) updateReservationField(reservation.reservationId, 'calendarEventId', eventId);
    } catch (e) {
      console.warn('Calendar registration failed:', e);
    }

    // メール送信（変更完了メール）
    try {
      sendChangeCompletedEmail(oldReservation, reservation);
    } catch (e) {
      console.error('Change email failed:', e);
    }

    // スタッフ通知
    try {
      notifyStaff(reservation, 'changed');
    } catch (e) {
      console.warn('Staff notification failed:', e);
    }

    return {
      success: true,
      message: '予約内容を変更しました。確認メールをお送りしています。',
      reservationId: reservation.reservationId,
    };
  } catch (err) {
    console.error('submitChange error:', err);
    return { success: false, message: 'エラーが発生しました：' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 手動予約作成（管理画面から呼ばれる）
 * 通常の submitReservation と違い：
 * - メール・電話は任意
 * - 当日の予約も受け付ける
 * - メールアドレスがあれば確認メールを送信
 */
function submitManualReservation(data, token) {
  if (!isValidAdminToken(token)) {
    return { success: false, message: '権限エラー：トークンが不正です。' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, message: '混み合っています。再度お試しください。' };
  }

  try {
    const validation = validateManualReservationData(data);
    if (!validation.ok) {
      return { success: false, message: validation.message };
    }

    const totalPeople = Number(data.adults) + extractChildCounts(data).children;
    const availability = getSlotAvailability(data.reservationDate, data.slot);
    if (availability.isHoliday) {
      return { success: false, message: 'この日は休業日として登録されています。' };
    }
    if (availability.available < totalPeople) {
      return {
        success: false,
        message: `この枠は残り${availability.available}名です。人数を調整するか別の枠をお選びください。`
      };
    }

    const reservation = writeReservation(data, totalPeople);

    try {
      const eventId = createCalendarEvent(reservation);
      if (eventId) updateReservationField(reservation.reservationId, 'calendarEventId', eventId);
    } catch (e) {
      console.warn('Calendar registration failed:', e);
    }

    // メールアドレスがあれば確認メール送信
    if (reservation.email && isValidEmail(reservation.email)) {
      try {
        sendConfirmationEmail(reservation);
      } catch (e) {
        console.error('Confirmation email failed:', e);
      }
    }

    try {
      notifyStaff(reservation, 'created');
    } catch (e) {
      console.warn('Staff notification failed:', e);
    }

    return {
      success: true,
      message: '手動予約を登録しました。',
      reservationId: reservation.reservationId,
      emailSent: !!(reservation.email && isValidEmail(reservation.email)),
    };
  } catch (err) {
    console.error('submitManualReservation error:', err);
    return { success: false, message: 'エラーが発生しました：' + err.message };
  } finally {
    lock.releaseLock();
  }
}

// ===========================================================================
// 受付締切（各枠の開始 BOOKING_CUTOFF_MINUTES 分前まで受付）
// ===========================================================================

/**
 * 枠の開始日時を返す。
 * new Date(y, m-1, d, H, M) はスクリプトのタイムゾーン（appsscript.json = Asia/Tokyo）で
 * 解釈される。createCalendarEvent と同じ組み立て方。
 *
 * @returns {Date|null} 枠IDや日付が不正なら null
 */
function getSlotStartDate(dateStr, slotId) {
  const slotDef = CONFIG.SLOTS.find(s => s.id === slotId);
  if (!slotDef) return null;
  const parts = String(dateStr || '').split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d, slotDef.startHour, slotDef.startMinute, 0, 0);
}

/**
 * 枠の受付締切時刻（開始の BOOKING_CUTOFF_MINUTES 分前）
 * @returns {Date|null}
 */
function getSlotCutoffDate(dateStr, slotId) {
  const start = getSlotStartDate(dateStr, slotId);
  if (!start) return null;
  return new Date(start.getTime() - CONFIG.BOOKING_CUTOFF_MINUTES * 60 * 1000);
}

/**
 * その枠がまだ受付可能か（＝締切前か）を判定する。
 *
 * 締切ちょうど（11:00の枠なら10:30:00.000）は受付OK、それより後はNG。
 * 過去日の枠は締切がとうに過ぎているので自動的に false になる。
 *
 * 空き状況API・予約バリデーションの両方からこの1関数を呼ぶことで、
 * 「カレンダーでは押せたのに送信したら弾かれる」ズレが起きないようにしている。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} slotId  'slot1' など
 * @param {Date|number} [now] 判定の基準時刻。省略時は現在時刻。テストで任意時刻を注入するために使う
 * @returns {boolean}
 */
function isSlotBookable(dateStr, slotId, now) {
  const cutoff = getSlotCutoffDate(dateStr, slotId);
  if (!cutoff) return false; // 不正な枠ID・日付は受け付けない
  let t;
  if (now instanceof Date) {
    t = now;
  } else if (now == null) {
    t = new Date();
  } else {
    t = new Date(now);
  }
  return t.getTime() <= cutoff.getTime();
}

// ===========================================================================
// バリデーション
// ===========================================================================

function validateReservationData(data) {
  if (!data.reservationDate) return { ok: false, message: '日付を選択してください。' };
  if (!data.slot) return { ok: false, message: '時間枠を選択してください。' };
  if (!CONFIG.SLOTS.find(s => s.id === data.slot)) {
    return { ok: false, message: '時間枠が不正です。' };
  }
  if (!data.name || !data.name.trim()) return { ok: false, message: 'お名前を入力してください。' };
  if (!data.email || !isValidEmail(data.email)) return { ok: false, message: 'メールアドレスを正しく入力してください。' };
  if (!data.phone || !data.phone.trim()) return { ok: false, message: '電話番号を入力してください。' };

  const adults = Number(data.adults);
  const children = extractChildCounts(data).children;
  if (!Number.isFinite(adults) || adults < 1) return { ok: false, message: '大人の人数は1名以上必要です。' };
  if (!Number.isFinite(children) || children < 0) return { ok: false, message: 'お子様の人数が不正です。' };
  const total = adults + children;
  if (total > CONFIG.CAPACITY_PER_SLOT) {
    return { ok: false, message: `1回のご予約は${CONFIG.CAPACITY_PER_SLOT}名までです。` };
  }

  // 予約日の範囲チェック
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const resDate = parseDate(data.reservationDate);
  const minDate = new Date(today);
  minDate.setDate(minDate.getDate() + CONFIG.MIN_BOOKING_DAYS_AHEAD);
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + CONFIG.BOOKING_WINDOW_DAYS);
  if (resDate < minDate) {
    return {
      ok: false,
      code: 'DATE_TOO_EARLY',
      message: CONFIG.MIN_BOOKING_DAYS_AHEAD > 0
        ? '当日のご予約は承っておりません。翌日以降をお選びください。'
        : '過去の日付はご予約いただけません。',
    };
  }
  if (resDate > maxDate) {
    return {
      ok: false,
      code: 'DATE_TOO_LATE',
      message: `ご予約は${CONFIG.BOOKING_WINDOW_DAYS}日先までとなります。`,
    };
  }

  // 受付締切チェック（当日枠は開始30分前まで）
  // カレンダーを開いたまま締切を跨いで送信されるケースは、ここで最終的に弾く
  if (!isSlotBookable(data.reservationDate, data.slot)) {
    return {
      ok: false,
      code: 'SLOT_CLOSED',
      message: `恐れ入ります、この枠の受付は終了しました（開始${CONFIG.BOOKING_CUTOFF_MINUTES}分前まで）。別のお時間をお選びください。`,
    };
  }

  return { ok: true };
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * 手動予約用バリデーション
 * - 名前は必須、メール・電話は任意
 * - 当日の予約もOK
 */
function validateManualReservationData(data) {
  if (!data.reservationDate) return { ok: false, message: '日付を選択してください。' };
  if (!data.slot) return { ok: false, message: '時間枠を選択してください。' };
  if (!CONFIG.SLOTS.find(s => s.id === data.slot)) {
    return { ok: false, message: '時間枠が不正です。' };
  }
  if (!data.name || !data.name.trim()) return { ok: false, message: 'お名前を入力してください。' };

  if (data.email && !isValidEmail(data.email)) {
    return { ok: false, message: 'メールアドレスの形式が正しくありません。' };
  }

  const adults = Number(data.adults);
  const children = extractChildCounts(data).children;
  if (!Number.isFinite(adults) || adults < 1) return { ok: false, message: '大人の人数は1名以上必要です。' };
  if (!Number.isFinite(children) || children < 0) return { ok: false, message: 'お子様の人数が不正です。' };
  const total = adults + children;
  if (total > CONFIG.CAPACITY_PER_SLOT) {
    return { ok: false, message: `1回のご予約は${CONFIG.CAPACITY_PER_SLOT}名までです。` };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const resDate = parseDate(data.reservationDate);
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + CONFIG.ADMIN_BOOKING_WINDOW_DAYS);
  if (resDate < today) {
    return { ok: false, message: '過去の日付は選択できません。' };
  }
  if (resDate > maxDate) {
    return { ok: false, message: `管理画面の予約可能範囲は${CONFIG.ADMIN_BOOKING_WINDOW_DAYS}日先までです。` };
  }

  return { ok: true };
}

// ===========================================================================
// スプレッドシート操作
// ===========================================================================

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || CONFIG.SPREADSHEET_ID;
  if (id) return SpreadsheetApp.openById(id);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getReservationsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.RESERVATIONS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.RESERVATIONS_SHEET);
    initializeReservationsSheet(sheet);
  }
  return sheet;
}

function getHolidaysSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.HOLIDAYS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.HOLIDAYS_SHEET);
    initializeHolidaysSheet(sheet);
  }
  return sheet;
}

function initializeHolidaysSheet(sheet) {
  sheet.getRange(1, 1, 1, 3).setValues([['日付', '営業/休業', 'メモ']]);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#f0ebe0');
  sheet.setFrozenRows(1);
  sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 240);

  // B列にプルダウン（「営業」or「休み」）を設定
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['営業', '休み'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 2, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
}

const RESERVATION_HEADERS = [
  'reservationId', 'createdAt', 'status', 'reservationDate', 'slot', 'slotLabel',
  'name', 'phone', 'email', 'adults', 'children', 'totalPeople',
  'source', 'notes', 'cancelToken', 'reminderSent', 'calendarEventId', 'updatedAt', 'thankYouSent',
  'schoolChildren', 'preschoolChildren'
];

function initializeReservationsSheet(sheet) {
  sheet.getRange(1, 1, 1, RESERVATION_HEADERS.length).setValues([RESERVATION_HEADERS]);
  sheet.getRange(1, 1, 1, RESERVATION_HEADERS.length).setFontWeight('bold').setBackground('#f0ebe0');
  sheet.setFrozenRows(1);
  const phoneCol = RESERVATION_HEADERS.indexOf('phone') + 1;
  if (phoneCol > 0) {
    sheet.getRange(2, phoneCol, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  }
  sheet.autoResizeColumns(1, RESERVATION_HEADERS.length);
}

function getAllActiveReservations() {
  const sheet = getReservationsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, RESERVATION_HEADERS.length).getValues();
  return values
    .map(row => rowToReservation(row))
    .filter(r => r.status === STATUS.CONFIRMED);
}

// 空き状況の集計で読む列の範囲（C列〜L列）
const AVAIL_FIRST_COL = 3;  // status
const AVAIL_LAST_COL = 12;  // totalPeople

/**
 * 空き状況の集計だけに使う、軽量版の予約読み込み。
 *
 * 予約シートは開業以来ずっと行が増え続けるので、全21列を読むと行数に比例して遅くなる。
 * 集計に必要なのは status / reservationDate / slot / 人数 だけなので、
 * C列(status)〜L列(totalPeople) の10列に絞って読む（読むセル数がおよそ半分になる）。
 *
 * ※ 予約オブジェクト全体が要る用途（メール送信・重複チェック等）は
 *   従来どおり getAllActiveReservations() を使うこと。
 *
 * @returns {Array<{reservationDate: string, slot: string, totalPeople: number}>}
 */
function getActiveBookingRows() {
  const sheet = getReservationsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const numCols = AVAIL_LAST_COL - AVAIL_FIRST_COL + 1;
  // 切り出した範囲の中での位置に変換する（RESERVATION_HEADERS は0始まり、列番号は1始まり）
  const offset = h => RESERVATION_HEADERS.indexOf(h) + 1 - AVAIL_FIRST_COL;
  const iStatus = offset('status');
  const iDate = offset('reservationDate');
  const iSlot = offset('slot');
  const iAdults = offset('adults');
  const iChildren = offset('children');
  const iTotal = offset('totalPeople');

  // 列順が変わった時に黙って壊れないよう保険をかける。
  // 想定外なら従来の全列読み込みにフォールバックする（遅いだけで結果は正しい）。
  const idxs = [iStatus, iDate, iSlot, iAdults, iChildren, iTotal];
  if (idxs.some(i => i < 0 || i >= numCols)) {
    console.warn('getActiveBookingRows: 列レイアウトが想定外のため全列読み込みにフォールバック');
    return getAllActiveReservations();
  }

  const values = sheet.getRange(2, AVAIL_FIRST_COL, lastRow - 1, numCols).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (row[iStatus] !== STATUS.CONFIRMED) continue;
    let dateStr = row[iDate];
    if (dateStr instanceof Date) dateStr = formatDate(dateStr);
    out.push({
      reservationDate: dateStr,
      slot: row[iSlot],
      // totalPeople が空の旧データは adults + children で補う（rowToReservation と同じ扱い）
      totalPeople: Number(row[iTotal]) || ((Number(row[iAdults]) || 0) + (Number(row[iChildren]) || 0)),
    });
  }
  return out;
}

function rowToReservation(row) {
  const r = {};
  RESERVATION_HEADERS.forEach((h, i) => {
    r[h] = row[i];
  });
  // 日付を文字列に正規化
  if (r.reservationDate instanceof Date) {
    r.reservationDate = formatDate(r.reservationDate);
  }
  // 数値
  r.adults = Number(r.adults) || 0;
  r.children = Number(r.children) || 0;
  r.totalPeople = Number(r.totalPeople) || (r.adults + r.children);
  // 子ども内訳（旧データは空欄＝不明のまま保持）
  r.schoolChildren = (r.schoolChildren === '' || r.schoolChildren == null) ? '' : (Number(r.schoolChildren) || 0);
  r.preschoolChildren = (r.preschoolChildren === '' || r.preschoolChildren == null) ? '' : (Number(r.preschoolChildren) || 0);
  return r;
}

function findReservationByToken(token) {
  if (!token) return null;
  const sheet = getReservationsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, RESERVATION_HEADERS.length).getValues();
  const tokenIdx = RESERVATION_HEADERS.indexOf('cancelToken');
  for (let i = 0; i < values.length; i++) {
    if (values[i][tokenIdx] === token) {
      return rowToReservation(values[i]);
    }
  }
  return null;
}

function findRowIndexByReservationId(reservationId) {
  const sheet = getReservationsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues(); // reservationId列のみ
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === reservationId) return i + 2;
  }
  return -1;
}

/**
 * 子どもの人数を新旧ペイロード両対応で取り出す。
 * 新フォーム: schoolChildren(小学生以上) / preschoolChildren(未就学) を送信
 * 旧フォーム: children(子ども合計)のみ
 * children は常に「子ども合計」を表す（既存 children 列の意味を維持）。
 * 内訳が無い（旧フォーム）場合、school/pre は空欄('')＝不明として保存。
 */
function extractChildCounts(data) {
  const hasBreakdown = (data.schoolChildren != null && data.schoolChildren !== '') ||
                       (data.preschoolChildren != null && data.preschoolChildren !== '');
  if (hasBreakdown) {
    const school = Math.max(0, Number(data.schoolChildren) || 0);
    const pre = Math.max(0, Number(data.preschoolChildren) || 0);
    return { school: school, pre: pre, children: school + pre, hasBreakdown: true };
  }
  return { school: '', pre: '', children: Math.max(0, Number(data.children) || 0), hasBreakdown: false };
}

// 二重送信対策: 同じ電話番号 or メールアドレス＋同日＋同枠の予約が
// 直近数分以内に既に作成されていないか確認する（ネットワーク不調時の再送信で重複行ができる事故を防ぐ）
const DUPLICATE_CHECK_WINDOW_MS = 3 * 60 * 1000; // 3分

function findRecentDuplicateReservation(data) {
  const phone = (data.phone || '').trim();
  const email = (data.email || '').trim();
  if (!phone && !email) return null;

  const now = Date.now();
  const active = getAllActiveReservations();
  for (const r of active) {
    if (r.reservationDate !== data.reservationDate) continue;
    if (r.slot !== data.slot) continue;
    const samePhone = phone && r.phone === phone;
    const sameEmail = email && r.email === email;
    if (!samePhone && !sameEmail) continue;

    const createdAt = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime();
    if (now - createdAt <= DUPLICATE_CHECK_WINDOW_MS) {
      return r;
    }
  }
  return null;
}

function writeReservation(data, totalPeople) {
  const sheet = getReservationsSheet();
  const reservationId = generateId('R');
  const cancelToken = generateToken();
  const slotDef = CONFIG.SLOTS.find(s => s.id === data.slot);
  const now = new Date();
  const cc = extractChildCounts(data);

  // 当日予約はリマインドメールの対象外にする。
  // 数時間後のご来店に「明日／本日ご来店です」のメールは不要で、
  // 直前に送る予約確認メールと内容が重複するため。
  // 変更（submitChange）も旧行を CHANGED にして新規行を作る設計なので、
  // 「明日→当日」に変えた予約はここで自動的に対象外になり、
  // 逆に「当日→明日」に変えた予約は false に戻ってリマインドが復活する。
  const isSameDayBooking = (data.reservationDate === formatDate(now));

  const reservation = {
    reservationId: reservationId,
    createdAt: now,
    status: STATUS.CONFIRMED,
    reservationDate: data.reservationDate,
    slot: data.slot,
    slotLabel: slotDef ? slotDef.label : data.slot,
    name: (data.name || '').trim(),
    phone: (data.phone || '').trim(),
    email: (data.email || '').trim(),
    adults: Number(data.adults),
    children: cc.children,
    schoolChildren: cc.school,
    preschoolChildren: cc.pre,
    totalPeople: totalPeople,
    source: (data.source || '').trim(),
    notes: (data.notes || '').trim(),
    cancelToken: cancelToken,
    reminderSent: isSameDayBooking,
    calendarEventId: '',
    updatedAt: now,
    thankYouSent: false,
  };

  const row = RESERVATION_HEADERS.map(h => reservation[h]);
  sheet.appendRow(row);
  const lastRow = sheet.getLastRow();
  const phoneCol = RESERVATION_HEADERS.indexOf('phone') + 1;
  if (phoneCol > 0) {
    sheet.getRange(lastRow, phoneCol).setNumberFormat('@').setValue(reservation.phone);
  }
  return reservation;
}

function updateReservationField(reservationId, fieldName, value) {
  const rowIdx = findRowIndexByReservationId(reservationId);
  if (rowIdx < 0) return;
  const colIdx = RESERVATION_HEADERS.indexOf(fieldName);
  if (colIdx < 0) return;
  getReservationsSheet().getRange(rowIdx, colIdx + 1).setValue(value);
}

function getSlotAvailability(dateStr, slotId) {
  const reservations = getActiveBookingRows();
  let booked = 0;
  reservations.forEach(r => {
    if (r.reservationDate === dateStr && r.slot === slotId) {
      booked += r.totalPeople;
    }
  });
  const holidaySet = getHolidaySet(parseDate(dateStr), parseDate(dateStr));
  return {
    booked: booked,
    available: Math.max(0, CONFIG.CAPACITY_PER_SLOT - booked),
    isHoliday: holidaySet.has(dateStr),
    closed: !isSlotBookable(dateStr, slotId),
  };
}

// ===========================================================================
// 休業日（Holidaysシートから取得）
// ===========================================================================

/**
 * 指定期間の休業日を集合で返す
 * Holidaysシート（A:日付, B:営業/休業, C:メモ）を読み、
 * B列が「休み」の行のみを休業日として返す
 */
function getHolidaySet(startDate, endDate) {
  const set = new Set();
  try {
    const sheet = getHolidaysSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return set;

    const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    values.forEach(row => {
      const d = row[0];
      const status = row[1];
      // 「休み」のみを休業日として扱う（「営業」や空欄は無視）
      if (status !== '休み') return;
      if (!d) return;

      let dateObj = null;
      if (d instanceof Date) {
        dateObj = d;
      } else if (typeof d === 'string' && d.trim()) {
        // 'YYYY-MM-DD' or 'YYYY/MM/DD' を許容
        const parts = d.replace(/\//g, '-').split('-').map(Number);
        if (parts.length === 3 && parts.every(n => Number.isFinite(n))) {
          dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
        }
      }
      if (!dateObj) return;
      const normalized = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
      if (normalized >= startDate && normalized <= endDate) {
        set.add(formatDate(normalized));
      }
    });
  } catch (e) {
    console.warn('getHolidaySet failed:', e);
  }
  return set;
}

function createCalendarEvent(reservation) {
  const calId = PropertiesService.getScriptProperties().getProperty('RESERVATION_CALENDAR_ID') || CONFIG.RESERVATION_CALENDAR_ID;
  if (!calId) return '';
  const cal = CalendarApp.getCalendarById(calId);
  if (!cal) return '';
  const slotDef = CONFIG.SLOTS.find(s => s.id === reservation.slot);
  if (!slotDef) return '';

  const [y, m, d] = reservation.reservationDate.split('-').map(Number);
  const start = new Date(y, m - 1, d, slotDef.startHour, slotDef.startMinute);
  const end = new Date(y, m - 1, d, slotDef.endHour, slotDef.endMinute);

  const _hasBreakdown = (reservation.schoolChildren !== '' && reservation.schoolChildren != null) ||
                        (reservation.preschoolChildren !== '' && reservation.preschoolChildren != null);
  const _childInfo = _hasBreakdown
    ? `子供${reservation.children}（小学生以上${reservation.schoolChildren || 0}・未就学${reservation.preschoolChildren || 0}）`
    : `子供${reservation.children}`;
  const title = `【予約】${reservation.name}様 ${reservation.totalPeople}名（大人${reservation.adults}・${_childInfo}）`;
  const description = [
    `予約ID: ${reservation.reservationId}`,
    `電話: ${reservation.phone}`,
    `メール: ${reservation.email}`,
    `きっかけ: ${reservation.source}`,
    `備考: ${reservation.notes}`,
  ].join('\n');
  const event = cal.createEvent(title, start, end, { description: description });
  return event.getId();
}

function deleteCalendarEvent(eventId) {
  const calId = PropertiesService.getScriptProperties().getProperty('RESERVATION_CALENDAR_ID') || CONFIG.RESERVATION_CALENDAR_ID;
  if (!calId) return;
  const cal = CalendarApp.getCalendarById(calId);
  if (!cal) return;
  const ev = cal.getEventById(eventId);
  if (ev) ev.deleteEvent();
}

// ===========================================================================
// メール送信
// ===========================================================================

function getWebAppUrl() {
  return ScriptApp.getService().getUrl() || '';
}

function buildCancelUrl(token) {
  // GitHub Pages 上のキャンセルページへ
  return `${CONFIG.FRONTEND_BASE_URL}/cancel.html?token=${encodeURIComponent(token)}`;
}

function buildChangeUrl(token) {
  // GitHub Pages 上の変更ページへ
  return `${CONFIG.FRONTEND_BASE_URL}/change.html?token=${encodeURIComponent(token)}`;
}

function sendConfirmationEmail(reservation) {
  const subject = `【${CONFIG.STORE_NAME}】ご予約を承りました`;
  const body = renderEmailBody('EmailConfirmation', {
    reservation: reservation,
    cancelUrl: buildCancelUrl(reservation.cancelToken),
    changeUrl: buildChangeUrl(reservation.cancelToken),
    storeName: CONFIG.STORE_NAME,
  });
  MailApp.sendEmail({
    to: reservation.email,
    subject: subject,
    htmlBody: body,
    name: CONFIG.STORE_EMAIL_FROM_NAME,
    replyTo: CONFIG.STORE_REPLY_EMAIL,
  });
}

function sendReminderEmail(reservation, isToday) {
  const dayLabel = isToday ? '本日' : '明日';
  const subject = `【${CONFIG.STORE_NAME}】${dayLabel}のご来店をお待ちしております`;

  // 地図画像を添付
  const attachments = [];
  const mapFileId = PropertiesService.getScriptProperties().getProperty('MAP_IMAGE_DRIVE_ID') || CONFIG.MAP_IMAGE_DRIVE_ID;
  if (mapFileId) {
    try {
      const file = DriveApp.getFileById(mapFileId);
      attachments.push(file.getBlob());
    } catch (e) {
      console.warn('Map image not found:', e);
    }
  }

  const body = renderEmailBody('EmailReminder', {
    reservation: reservation,
    isToday: isToday,
    cancelUrl: buildCancelUrl(reservation.cancelToken),
    changeUrl: buildChangeUrl(reservation.cancelToken),
    storeName: CONFIG.STORE_NAME,
  });
  MailApp.sendEmail({
    to: reservation.email,
    subject: subject,
    htmlBody: body,
    name: CONFIG.STORE_EMAIL_FROM_NAME,
    replyTo: CONFIG.STORE_REPLY_EMAIL,
    attachments: attachments,
  });
}

function sendCancellationEmail(reservation) {
  const subject = `【${CONFIG.STORE_NAME}】ご予約のキャンセルを承りました`;
  const body = renderEmailBody('EmailCancellation', {
    reservation: reservation,
    storeName: CONFIG.STORE_NAME,
  });
  MailApp.sendEmail({
    to: reservation.email,
    subject: subject,
    htmlBody: body,
    name: CONFIG.STORE_EMAIL_FROM_NAME,
    replyTo: CONFIG.STORE_REPLY_EMAIL,
  });
}

function sendChangeCompletedEmail(oldReservation, newReservation) {
  const subject = `【${CONFIG.STORE_NAME}】ご予約内容を変更しました`;
  const body = renderEmailBody('EmailChange', {
    oldReservation: oldReservation,
    reservation: newReservation,
    cancelUrl: buildCancelUrl(newReservation.cancelToken),
    changeUrl: buildChangeUrl(newReservation.cancelToken),
    storeName: CONFIG.STORE_NAME,
  });
  MailApp.sendEmail({
    to: newReservation.email,
    subject: subject,
    htmlBody: body,
    name: CONFIG.STORE_EMAIL_FROM_NAME,
    replyTo: CONFIG.STORE_REPLY_EMAIL,
  });
}

function sendThankYouEmail(reservation) {
  const subject = `【${CONFIG.STORE_NAME}】本日はご来店ありがとうございました`;
  const body = renderEmailBody('EmailThankYou', {
    reservation: reservation,
    googleReviewUrl: CONFIG.GOOGLE_REVIEW_URL,
    storeName: CONFIG.STORE_NAME,
  });
  MailApp.sendEmail({
    to: reservation.email,
    subject: subject,
    htmlBody: body,
    name: CONFIG.STORE_EMAIL_FROM_NAME,
    replyTo: CONFIG.STORE_REPLY_EMAIL,
  });
}

function renderEmailBody(templateName, data) {
  const tpl = HtmlService.createTemplateFromFile(templateName);
  Object.keys(data).forEach(k => {
    tpl[k] = data[k];
  });
  return tpl.evaluate().getContent();
}

// ===========================================================================
// スタッフ通知（拡張ポイント）
// ===========================================================================

/**
 * 予約イベント発生時のスタッフ通知。
 * 現在は無効（毎日スプシを確認する運用）。
 * 将来的にメール/Slack/Discord等に通知したい場合はここを実装。
 *
 * @param {Object} reservation 予約オブジェクト
 * @param {string} eventType 'created' | 'cancelled' | 'changed'
 */
function notifyStaff(reservation, eventType) {
  // 今は何もしない。拡張時は以下のような実装を追加：
  //
  // const staffEmails = ['kotoku@example.com'];
  // const subjects = {
  //   created: `【新規予約】${reservation.reservationDate} ${reservation.slotLabel} ${reservation.name}様`,
  //   cancelled: `【キャンセル】${reservation.reservationDate} ${reservation.slotLabel} ${reservation.name}様`,
  //   changed: `【変更】${reservation.reservationDate} ${reservation.slotLabel} ${reservation.name}様`,
  // };
  // MailApp.sendEmail({ to: staffEmails.join(','), subject: subjects[eventType], body: ... });
  //
  // Slack Webhook:
  // UrlFetchApp.fetch(SLACK_WEBHOOK_URL, { method: 'post', payload: JSON.stringify({ text: ... }) });
}

// ===========================================================================
// 日次トリガー
// ===========================================================================

/**
 * 翌日リマインドメール送信（前日19:00トリガーで実行）
 * 翌日の予約に対して「明日のご来店」メールを送る。
 */
function sendTomorrowReminders() {
  sendRemindersForOffset(1, false);
}

/**
 * 当日リマインドメール送信（当日09:00トリガーで実行）
 * 前日リマインドが間に合わなかった当日予約のフォロー。
 */
function sendTodayReminders() {
  sendRemindersForOffset(0, true);
}

function sendRemindersForOffset(dayOffset, isToday) {
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + dayOffset);
  const targetStr = formatDate(target);

  const reservations = getAllActiveReservations();
  const targets = reservations.filter(r =>
    r.reservationDate === targetStr &&
    !r.reminderSent &&
    r.email && isValidEmail(r.email) // メアド未入力の手動予約はリマインド対象外
  );

  let sent = 0;
  let failed = 0;
  targets.forEach(r => {
    try {
      sendReminderEmail(r, isToday);
      updateReservationField(r.reservationId, 'reminderSent', true);
      sent++;
    } catch (e) {
      console.error(`Reminder failed for ${r.reservationId}:`, e);
      failed++;
    }
  });
  console.log(`Reminders (${isToday ? 'today' : 'tomorrow'}): sent=${sent} failed=${failed} target=${targetStr}`);
}

/**
 * サンクスメール送信（来店当日 18:30 トリガーで実行）
 * 当日来店分の予約に対して、お礼＋クチコミ依頼メールを送る。
 * メアド未入力の手動予約は対象外。
 */
function sendThankYouEmails() {
  const todayStr = formatDate(new Date());
  const reservations = getAllActiveReservations();
  const targets = reservations.filter(r =>
    r.reservationDate === todayStr &&
    !r.thankYouSent &&
    r.email && isValidEmail(r.email)
  );

  let sent = 0;
  let failed = 0;
  targets.forEach(r => {
    try {
      sendThankYouEmail(r);
      updateReservationField(r.reservationId, 'thankYouSent', true);
      sent++;
    } catch (e) {
      console.error(`Thank-you failed for ${r.reservationId}:`, e);
      failed++;
    }
  });
  console.log(`Thank-you mails: sent=${sent} failed=${failed} target=${todayStr}`);
}

// ===========================================================================
// 初期セットアップ用の関数（手動実行）
// ===========================================================================

/**
 * スクリプトプロパティを設定する（初回セットアップ時に手動で値を埋めて実行）
 */
function setupScriptProperties() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    SPREADSHEET_ID: 'ここにスプレッドシートIDを入れる',
    RESERVATION_CALENDAR_ID: 'ここに予約を書き込む用のGoogleカレンダーIDを入れる',
    MAP_IMAGE_DRIVE_ID: 'ここに道のり案内画像のGoogleドライブファイルIDを入れる',
  });
  console.log('Script properties set.');
}

/**
 * リマインド用のトリガーを作成（一度だけ手動実行）
 * 翌日19:00 と 当日09:00 の2本を設置する。
 */
function installReminderTriggers() {
  // 既存のリマインド系トリガーを削除（旧 sendDailyReminders も含む）
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'sendDailyReminders' || fn === 'sendTomorrowReminders' || fn === 'sendTodayReminders') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 前日リマインド（翌日の予約が対象）
  ScriptApp.newTrigger('sendTomorrowReminders')
    .timeBased()
    .atHour(CONFIG.REMINDER_HOUR_TOMORROW)
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  // 当日リマインド（前日に取りこぼした当日予約のフォロー）
  ScriptApp.newTrigger('sendTodayReminders')
    .timeBased()
    .atHour(CONFIG.REMINDER_HOUR_TODAY)
    .nearMinute(CONFIG.REMINDER_MINUTE_TODAY)
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  console.log(`Reminder triggers installed: tomorrow=${CONFIG.REMINDER_HOUR_TOMORROW}:00, today=${CONFIG.REMINDER_HOUR_TODAY}:${CONFIG.REMINDER_MINUTE_TODAY}`);
}

/**
 * サンクスメール用のトリガーを作成（一度だけ手動実行）
 * 来店当日 18:30 に当日分の予約へ送る。
 */
function installThankYouTrigger() {
  // 既存のサンクスメール系トリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendThankYouEmails') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('sendThankYouEmails')
    .timeBased()
    .atHour(CONFIG.THANKYOU_HOUR)
    .nearMinute(CONFIG.THANKYOU_MINUTE)
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  console.log(`Thank-you trigger installed: ${CONFIG.THANKYOU_HOUR}:${CONFIG.THANKYOU_MINUTE}`);
}

/**
 * 既存の Reservations シートにヘッダ列を追加する（既存運用中シートのマイグレーション用）
 * RESERVATION_HEADERS に列を増やした後に一度だけ手動実行する。
 * - 末尾列の追加のみを想定（途中への挿入は手動対応が必要）
 * - データはそのまま、ヘッダ行のみ拡張する
 */
function ensureReservationHeaders() {
  const sheet = getReservationsSheet();
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    initializeReservationsSheet(sheet);
    console.log('Sheet initialized from scratch.');
    return;
  }
  if (lastCol >= RESERVATION_HEADERS.length) {
    // 念のため既存ヘッダ名が定義と一致しているかチェック
    const current = sheet.getRange(1, 1, 1, RESERVATION_HEADERS.length).getValues()[0];
    const diff = RESERVATION_HEADERS.filter((h, i) => current[i] !== h);
    if (diff.length === 0) {
      console.log('Headers already up to date.');
    } else {
      console.warn('Header mismatch detected:', diff);
    }
    return;
  }
  // 不足分を末尾に追加
  const missing = RESERVATION_HEADERS.slice(lastCol);
  sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#f0ebe0');
  console.log(`Headers extended: added ${missing.join(', ')}`);
}

/**
 * スプレッドシートの Reservations シートを初期化
 */
function initializeSheet() {
  const sheet = getReservationsSheet();
  if (sheet.getLastRow() === 0) {
    initializeReservationsSheet(sheet);
  }
  console.log('Sheet initialized.');
}

// ===========================================================================
// ユーティリティ
// ===========================================================================

function formatDate(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function parseDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function generateId(prefix) {
  const ts = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMddHHmmss');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${ts}${rand}`;
}

function generateToken() {
  // 32文字のランダムトークン
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateForDisplay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${y}年${m}月${d}日(${weekdays[date.getDay()]})`;
}

// ===========================================================================
// テスト用（GASエディタから手動実行。シート書き込み・メール送信は一切しない）
// ===========================================================================

/**
 * 受付締切判定のテスト。
 * isSlotBookable の第3引数に任意の「現在時刻」を注入して境界を確認する。
 * 本番プロジェクトで実行しても安全（読み取りすらしない純関数テスト）。
 */
function test_isSlotBookable() {
  // new Date(y, m-1, d, H, M, S) はスクリプトTZ（Asia/Tokyo）で解釈される
  const cases = [
    // [日付, 枠, now, 期待値, 説明]
    ['2026-08-25', 'slot1', new Date(2026, 7, 25, 10, 29, 59), true,  '11時枠 締切1秒前'],
    ['2026-08-25', 'slot1', new Date(2026, 7, 25, 10, 30, 0),  true,  '11時枠 締切ちょうど＝受付OK'],
    ['2026-08-25', 'slot1', new Date(2026, 7, 25, 10, 30, 1),  false, '11時枠 締切1秒後＝受付NG'],
    ['2026-08-25', 'slot2', new Date(2026, 7, 25, 10, 30, 1),  true,  '11時枠が締切でも13時枠は生きている'],
    ['2026-08-25', 'slot2', new Date(2026, 7, 25, 12, 30, 0),  true,  '13時枠 締切ちょうど'],
    ['2026-08-25', 'slot2', new Date(2026, 7, 25, 12, 30, 1),  false, '13時枠 締切後'],
    ['2026-08-26', 'slot1', new Date(2026, 7, 25, 23, 59, 59), true,  '翌日の枠は前日深夜でもOK'],
    ['2026-08-24', 'slot1', new Date(2026, 7, 25, 0, 0, 0),    false, '過去日は常にNG'],
    ['2026-08-25', 'slotX', new Date(2026, 7, 25, 9, 0, 0),    false, '不正な枠IDはNG'],
    ['',           'slot1', new Date(2026, 7, 25, 9, 0, 0),    false, '日付が空ならNG'],
  ];

  let ng = 0;
  cases.forEach(c => {
    const actual = isSlotBookable(c[0], c[1], c[2]);
    const ok = (actual === c[3]);
    if (!ok) ng++;
    console.log(
      (ok ? 'PASS' : '*** FAIL ***') + ' ' + c[4] +
      ' | ' + c[0] + ' ' + c[1] +
      ' now=' + Utilities.formatDate(c[2], CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss') +
      ' expected=' + c[3] + ' actual=' + actual
    );
  });
  console.log(ng === 0 ? '=== すべて成功 ===' : '=== ' + ng + '件 失敗 ===');
}

/**
 * 当日の空き状況に closed フラグが正しく付くかを目視確認する（読み取りのみ）。
 */
function test_availabilityClosedFlag() {
  const todayStr = formatDate(new Date());
  console.log('now = ' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
  console.log('--- 現在時刻での本日の空き状況 ---');
  console.log(JSON.stringify(getAvailabilityRange(todayStr, todayStr), null, 2));

  // 任意時刻での見え方（第3引数はテスト用）
  const p = todayStr.split('-').map(Number);
  console.log('--- 本日 10:31 時点（11時枠が締切後）---');
  console.log(JSON.stringify(
    getAvailabilityRange(todayStr, todayStr, new Date(p[0], p[1] - 1, p[2], 10, 31)), null, 2));
}
