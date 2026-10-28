/**
 * 训练历史 —— localStorage 持久化，纯数据层（渲染在 main.js）。
 *
 * 一条记录 = 一组训练（从开始计数到 停止/重置/切换动作 为止）：
 *   { time: ISO 字符串, exercise: "深蹲", total: 12, good: 9, cues: { shallow: 2, valgus: 1 } }
 *
 * 设计要点：
 *   - localStorage 在隐私模式/被禁用时会抛异常，所有读写都包 try/catch，坏了就当没有历史，不影响训练主流程。
 *   - 最多存 MAX_RECORDS 条（够算累计统计），UI 只展示最近 10 条。
 */

const KEY = "coach.history.v1";
const MAX_RECORDS = 50;

/** 读出全部历史（新→旧）。读不到/解析失败一律返回空数组。 */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 追加一条训练记录（插到最前，新→旧），返回最新的完整历史。
 * @param {{time:string, exercise:string, total:number, good:number, cues:Object<string,number>}} record
 */
export function addRecord(record) {
  const records = loadHistory();
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // 存不进去（配额/隐私模式）就只活在内存里，本次会话仍可见
  }
  return records;
}

/** 清空全部历史。 */
export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 忽略
  }
}

/**
 * 累计统计：组数、总次数、标准次数、各纠错规则累计触发次数。
 * @param {Array} records loadHistory() 的返回值
 */
export function aggregate(records) {
  const agg = { sets: records.length, reps: 0, goodReps: 0, cueTotals: {} };
  for (const r of records) {
    agg.reps += r.total ?? 0;
    agg.goodReps += r.good ?? 0;
    for (const [cue, n] of Object.entries(r.cues ?? {})) {
      agg.cueTotals[cue] = (agg.cueTotals[cue] ?? 0) + n;
    }
  }
  return agg;
}
