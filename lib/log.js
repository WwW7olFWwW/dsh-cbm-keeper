/**
 * 結構化日誌（NFR-4）。
 *
 * 上游 CBM daemon 日誌的行內沒有時間戳（P11），本插件不得重複那個缺點：每一
 * 筆都帶 ISO 時間戳、等級、事件名與結構化 detail。記憶體內保留最近 N 筆供
 * REST／UI 查詢，同時 append 到檔案（非同步、不阻塞事件迴圈、寫入失敗不致命）。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LOG_LEVELS } from './constants.js';

/** 等級排序，用於 `minLevel` 過濾。 */
const LEVEL_RANK = new Map(LOG_LEVELS.map(function (name, index) { return [name, index]; }));

/**
 * 把 detail 值正規化為單行可讀字串。
 * @param {unknown} value - 任意 detail 值。
 * @returns {string} 單行字串。
 */
function formatDetailValue(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    // 環狀結構或 BigInt：退回 String()，日誌不得因序列化失敗而中斷。
    return String(value);
  }
}

/**
 * 把 detail 物件串成 `k=v` 的單行尾串。
 * @param {Record<string, unknown> | undefined} detail - 結構化欄位。
 * @returns {string} 以空格開頭的字串，無欄位時為空字串。
 */
function formatDetail(detail) {
  if (detail === undefined || detail === null) return '';
  const parts = [];
  for (const key of Object.keys(detail)) {
    const value = detail[key];
    if (value === undefined) continue;
    const text = formatDetailValue(value);
    parts.push(key + '=' + (text.includes(' ') ? JSON.stringify(text) : text));
  }
  return parts.length === 0 ? '' : ' ' + parts.join(' ');
}

/**
 * 一支帶時間戳、有界記憶體、可選落檔的日誌器。
 */
export class KeeperLog {
  /**
   * @param {object} options - 建構選項。
   * @param {string | undefined} options.file - 落檔路徑；未給則只留在記憶體。
   * @param {number} options.maxEntries - 記憶體保留筆數上限。
   * @param {string} options.minLevel - 低於此等級的事件直接丟棄。
   * @param {() => void} [options.onChange] - 有新事件時的通知（供 UI 輪詢節流）。
   */
  constructor(options) {
    this.file = options.file;
    this.maxEntries = Math.max(1, options.maxEntries ?? 500);
    this.minLevel = options.minLevel ?? 'info';
    this.onChange = options.onChange;
    this.entries = [];
    this.sequence = 0;
    this.writeChain = Promise.resolve();
    this.ready = false;
    this.fileError = undefined;
  }

  /**
   * 建立日誌目錄並翻轉 ready 旗標。目錄建立失敗不致命：日誌留在記憶體。
   * @returns {Promise<void>} 目錄就緒後解決。
   */
  async open() {
    if (this.file === undefined) {
      this.ready = true;
      return;
    }
    try {
      await mkdir(dirname(this.file), { recursive: true });
      this.ready = true;
    } catch (error) {
      this.fileError = error instanceof Error ? error.message : String(error);
      this.ready = true;
    }
  }

  /**
   * 記錄一筆事件。
   * @param {string} level - info | warn | error | debug。
   * @param {string} event - 事件名（點分命名，如 `rebuild.start`）。
   * @param {Record<string, unknown>} [detail] - 結構化欄位。
   * @returns {object} 已落地的記憶體條目。
   */
  log(level, event, detail) {
    const entry = {
      seq: ++this.sequence,
      at: new Date().toISOString(),
      level,
      event,
      detail: detail ?? {},
    };
    const rank = LEVEL_RANK.get(level) ?? LEVEL_RANK.get('info');
    const floor = LEVEL_RANK.get(this.minLevel) ?? LEVEL_RANK.get('info');
    if (rank < floor) return entry;

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    if (this.onChange !== undefined) {
      try {
        this.onChange(entry);
      } catch {
        // 通知回呼的失敗不得影響日誌本身。
      }
    }
    this.appendLine(entry);
    return entry;
  }

  /** @param {string} event - 事件名。 @param {Record<string, unknown>} [detail] - 欄位。 @returns {object} 條目。 */
  info(event, detail) { return this.log('info', event, detail); }

  /** @param {string} event - 事件名。 @param {Record<string, unknown>} [detail] - 欄位。 @returns {object} 條目。 */
  warn(event, detail) { return this.log('warn', event, detail); }

  /** @param {string} event - 事件名。 @param {Record<string, unknown>} [detail] - 欄位。 @returns {object} 條目。 */
  error(event, detail) { return this.log('error', event, detail); }

  /** @param {string} event - 事件名。 @param {Record<string, unknown>} [detail] - 欄位。 @returns {object} 條目。 */
  debug(event, detail) { return this.log('debug', event, detail); }

  /**
   * 非同步補一行到檔案；錯誤只記在 fileError，不拋。
   * @param {object} entry - 記憶體條目。
   * @returns {void}
   */
  appendLine(entry) {
    if (this.file === undefined || !this.ready || this.fileError !== undefined) return;
    const line = entry.at + ' level=' + entry.level + ' msg=' + entry.event + formatDetail(entry.detail) + '\n';
    this.writeChain = this.writeChain
      .then(function () { return appendFile(this.file, line, 'utf8'); }.bind(this))
      .catch(function (error) {
        this.fileError = error instanceof Error ? error.message : String(error);
      }.bind(this));
  }

  /**
   * 最近的 N 筆（新的在後）。
   * @param {number} [limit] - 筆數，預設 100。
   * @param {string} [minLevel] - 只回此等級以上。
   * @returns {object[]} 條目陣列。
   */
  recent(limit, minLevel) {
    const floor = LEVEL_RANK.get(minLevel ?? 'info') ?? 0;
    const filtered = this.entries.filter(function (entry) {
      return (LEVEL_RANK.get(entry.level) ?? 0) >= floor;
    });
    const size = Math.max(1, Math.min(limit ?? 100, this.maxEntries));
    return filtered.slice(Math.max(0, filtered.length - size));
  }

  /** 調整記憶體保留上限（設定變更時重入）。 @param {number} next - 新上限。 @returns {void} */
  setMaxEntries(next) {
    this.maxEntries = Math.max(1, next);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  /** 等待所有落檔完成（測試與收尾用）。 @returns {Promise<void>} 寫入鏈的尾端。 */
  async flush() {
    await this.writeChain;
  }
}
