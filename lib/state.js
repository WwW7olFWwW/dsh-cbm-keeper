/**
 * 狀態檔（NFR-6）。
 *
 * 每個專案的監看意圖、上次結果、上次錯誤都落在
 * `~/.dsh/codebase-watcher/state.json`，原子寫入（先寫同目錄暫存檔再 rename）。
 * 崩潰後重啟時據此恢復意圖：掃描前仍是 `queued`／`running` 的專案會被重新
 * 排入重建佇列，而不是靜默地永遠停在那裡。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STATE_VERSION } from './constants.js';

/**
 * 判斷一個值是不是「純」JSON 物件。
 *
 * `typeof [] === 'object'` 是這裡唯一的重點：狀態檔被外部工具寫成陣列時，
 * 只檢查 typeof 會讓陣列穿過去，之後每一次 `projects[key]` 都拿到 undefined，
 * 症狀是「狀態檔明明有內容卻全部失憶」——比直接判為損毀更難查。
 *
 * @param {unknown} value - 待檢查的值。
 * @returns {boolean} 是純物件則 true。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 一份可原子落盤的狀態。
 */
export class KeeperState {
  /**
   * @param {object} options - 建構選項。
   * @param {string} options.file - 狀態檔絕對路徑。
   * @param {import('./log.js').KeeperLog} options.log - 日誌器。
   */
  constructor(options) {
    this.file = options.file;
    this.log = options.log;
    this.data = { version: STATE_VERSION, updatedAt: new Date().toISOString(), projects: {}, watchers: {} };
    this.saveChain = Promise.resolve();
    this.loadError = undefined;
  }

  /**
   * 從磁碟載入；檔案不存在或損毀時回退到空狀態（並記錄原因，不拋）。
   * @returns {Promise<{loaded: boolean, error: string|undefined}>} 載入結果。
   */
  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        throw new Error('狀態檔的頂層不是 JSON 物件');
      }
      this.data = {
        version: typeof parsed.version === 'number' ? parsed.version : STATE_VERSION,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        projects: isPlainObject(parsed.projects) ? parsed.projects : {},
        watchers: isPlainObject(parsed.watchers) ? parsed.watchers : {},
      };
      return { loaded: true, error: undefined };
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') return { loaded: false, error: undefined };
      this.loadError = error instanceof Error ? error.message : String(error);
      this.log.warn('state.load.failed', { error: this.loadError, file: this.file });
      return { loaded: false, error: this.loadError };
    }
  }

  /**
   * 讀取單一專案的狀態。
   * @param {string} key - 身分鍵。
   * @returns {object} 狀態物件（不存在時為空物件）。
   */
  project(key) {
    const value = this.data.projects[key];
    return value !== undefined && value !== null && typeof value === 'object' ? value : {};
  }

  /**
   * 合併更新單一專案的狀態並落盤。
   * @param {string} key - 身分鍵。
   * @param {object} patch - 要併入的欄位。
   * @returns {Promise<void>} 落盤完成。
   */
  async setProject(key, patch) {
    const current = this.project(key);
    this.data.projects[key] = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.save();
  }

  /**
   * 移除單一專案的狀態（專案不再是 git 工作樹或上游已刪時）。
   * @param {string} key - 身分鍵。
   * @returns {Promise<void>} 落盤完成。
   */
  async removeProject(key) {
    if (this.data.projects[key] === undefined) return;
    delete this.data.projects[key];
    await this.save();
  }

  /**
   * 原子寫入狀態檔。
   *
   * 寫入序列化在一條 promise 鏈上，避免兩次並發 save 互相覆蓋；rename 在同一
   * 目錄內進行，因此對讀者而言是「要嘛舊的、要嘛新的」。
   *
   * @returns {Promise<void>} 落盤完成。
   */
  async save() {
    const payload = JSON.stringify(
      { ...this.data, version: STATE_VERSION, updatedAt: new Date().toISOString() },
      null,
      2,
    );
    const target = this.file;
    const temporary = target + '.tmp-' + String(process.pid);
    this.saveChain = this.saveChain.then(async function () {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, target);
    }).catch(function (error) {
      this.log.warn('state.save.failed', { error: error instanceof Error ? error.message : String(error), file: target });
    }.bind(this));
    await this.saveChain;
  }

  /**
   * 匯出目前狀態的快照（給 REST 用）。
   * @returns {object} 深拷貝。
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
}
