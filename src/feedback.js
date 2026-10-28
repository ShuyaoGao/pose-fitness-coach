/**
 * 教练反馈生成 —— 第二阶段：本地 LLM（Ollama）+ 模板话术双轨。
 *
 * 分工不变（AGENT.md 铁律）：
 *   - 规则引擎（exercises/*.js）判对错，给结构化数据（次数 / cues / 深度统计）。
 *   - 本文件只负责「把事实说成人话」：
 *       · 即时反馈（每次动作完成）→ 模板话术，零延迟、零依赖；
 *       · 组总结 → 优先调本地 Ollama（OpenAI 兼容接口）生成口语化点评，
 *         Ollama 不可用 / 超时 / 返回异常时**无缝降级**回模板话术，UI 永不报错。
 *   - 绝不让 LLM 自己判断动作对错（小模型会幻觉夸错），Prompt 里只给规则引擎的结论。
 */

// ---- 本地 LLM 配置（Ollama 的 OpenAI 兼容接口，无需 API key）----
const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
const OLLAMA_MODEL = "qwen3:4b"; // 换模型只改这里（如 qwen3:8b）
const LLM_TIMEOUT_MS = 8000; //    超时即放弃，降级模板话术

/** 中文「错误标签 → 即时提示语」对照表（规则引擎输出 cue，这里翻译）。 */
const CUE_TEXT = {
  // 深蹲
  shallow: "蹲得还不够深，试着让大腿更接近与地面平行。",
  valgus: "注意膝盖别向内扣，让膝盖对准脚尖方向。",
  // 开合跳
  arms_low: "手臂要完全举过头顶，在头顶上方合拢再放下。",
  narrow: "双脚跳开的幅度再大一点，明显超过肩宽。",
};

/** 中文「错误标签 → 简短规则名」，喂给 LLM 的事实描述用（比整句提示语更省 token）。 */
const CUE_NAME = {
  shallow: "蹲得不够深",
  valgus: "膝盖内扣",
  arms_low: "手臂未举过头顶",
  narrow: "双脚张开幅度不足",
};

const PRAISE = [
  "标准！保持这个节奏 💪",
  "很棒，动作很到位 👍",
  "漂亮，核心稳住了！",
  "完美的一次！",
];

/**
 * 单次动作完成后的即时反馈（模板，零延迟——每次动作都调 LLM 既慢又没必要）。
 * @param {{index:number, cues:string[], good:boolean}} rep 规则引擎给的 lastRep
 * @returns {{text:string, good:boolean}}
 */
export function repFeedback(rep) {
  if (rep.good) {
    // 用 index 选一句表扬，避免依赖随机数（也方便复现）
    const praise = PRAISE[rep.index % PRAISE.length];
    return { text: `第 ${rep.index} 次：${praise}`, good: true };
  }
  const tips = rep.cues.map((c) => CUE_TEXT[c] ?? c).join(" ");
  return { text: `第 ${rep.index} 次：${tips}`, good: false };
}

/** 把 cue 标签翻译成「语音播报用」的短句（不带次数前缀，方便防刷屏去重）。 */
export function cueSpeechText(cues) {
  return cues.map((c) => CUE_TEXT[c] ?? c).join("");
}

/**
 * 一组练完后的总结反馈 —— 模板版（LLM 不可用时的降级话术，也用作即时占位）。
 * @param {{exercise?:string, total:number, goodCount:number}} stats
 */
export function setSummary({ exercise = "深蹲", total, goodCount }) {
  if (total === 0) return `还没开始，正对摄像头做几个${exercise}试试吧！`;
  const rate = Math.round((goodCount / total) * 100);
  if (rate >= 80) {
    return `本组${exercise}共 ${total} 次，其中 ${goodCount} 次标准（${rate}%）。完成度很高，下次可以尝试增加次数或放慢速度提高质量。`;
  }
  if (rate >= 50) {
    return `本组${exercise}共 ${total} 次，标准 ${goodCount} 次（${rate}%）。基础不错，重点改进上面提示的动作要点。`;
  }
  return `本组${exercise}共 ${total} 次，标准 ${goodCount} 次（${rate}%）。先放慢速度，把每一次都做到位再加量。`;
}

// ============ 本地 LLM（Ollama）组总结 ============

/**
 * qwen3 系列默认会输出 <think>…</think> 思考段，展示前剥离。
 * 兼容「没闭合的 <think>」（被 max_tokens 截断时）：此时整段都是思考，返回空串走降级。
 */
export function stripThink(text) {
  if (!text) return "";
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = out.indexOf("<think>");
  if (open !== -1) out = out.slice(0, open); // 残留未闭合的思考段 → 截掉
  return out.trim();
}

/** 把本组结构化数据拼成给 LLM 的中文事实描述（只给结论，不让它自己判对错）。 */
function buildSetPrompt({ exercise, total, goodCount, cueCounts, metricLabel, metricAvg }) {
  const lines = [
    `动作：${exercise}`,
    `总次数：${total}，其中标准 ${goodCount} 次`,
  ];
  const cueLines = Object.entries(cueCounts ?? {})
    .filter(([, n]) => n > 0)
    .map(([cue, n]) => `${CUE_NAME[cue] ?? cue} ×${n}`);
  lines.push(cueLines.length ? `规则引擎判出的问题：${cueLines.join("、")}` : "规则引擎未发现动作问题");
  if (metricLabel && metricAvg != null) {
    lines.push(`深度统计：本组平均${metricLabel} = ${metricAvg}`);
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = [
  "你是一名专业、亲切的中文健身教练。",
  "用户刚完成一组训练，下面给你的是动作识别系统（规则引擎）已经判定好的事实数据。",
  "请基于这些事实，用口语化的中文给出 2-3 句简短建议：先肯定做得好的地方，再针对出现的问题给出最重要的一条改进要点。",
  "要求：不要复述数字列表，不要使用 Markdown 或表情符号，不要自己推测数据之外的问题，总长度不超过 80 字。",
].join("");

/**
 * 调本地 Ollama 生成本组训练的教练点评。
 * 任何失败（连不上 / 超时 / 返回格式异常 / 剥离思考段后为空）都返回 null，
 * 由调用方降级到 setSummary() 模板——UI 永远有话可说、永不报错。
 *
 * @param {{exercise:string, total:number, goodCount:number,
 *          cueCounts:Object<string,number>, metricLabel?:string, metricAvg?:string|number}} setData
 * @returns {Promise<string|null>}
 */
export async function llmSetSummary(setData) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildSetPrompt(setData) },
        ],
        temperature: 0.7,
        max_tokens: 1024, // qwen3 的思考段也占 token，给足额度避免正文被截断
        stream: false,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    const text = stripThink(raw);
    return text || null;
  } catch {
    // 连接拒绝 / 超时（AbortError）/ JSON 解析失败 → 一律静默降级
    return null;
  } finally {
    clearTimeout(timer);
  }
}
