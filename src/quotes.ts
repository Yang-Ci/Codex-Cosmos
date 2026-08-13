export interface Quote {
  text: string;
  author: string;
  category: "tech" | "philosophy" | "life";
}

export const quotes: Quote[] = [
  { text: "真正重要的事，通常不需要大声提醒。", author: "Codex Cosmos", category: "life" },
  { text: "保持好奇，答案往往藏在第二个问题里。", author: "Codex Cosmos", category: "philosophy" },
  { text: "让复杂留在系统里，把简单留给使用者。", author: "设计札记", category: "tech" },
  { text: "清晰比聪明更稀缺，也更有力量。", author: "Codex Cosmos", category: "philosophy" },
  { text: "一次只推进一件真正重要的事情。", author: "深度工作", category: "life" },
  { text: "好的工具不会打断你，它只在需要时出现。", author: "Codex Cosmos", category: "tech" },
  { text: "先让它正确，再让它优雅，最后让它快速。", author: "工程箴言", category: "tech" },
  { text: "今天的微小改进，会成为明天的默认能力。", author: "Codex Cosmos", category: "life" },
  { text: "简单不是缺少内容，而是没有多余。", author: "设计札记", category: "philosophy" },
  { text: "写代码是在为未来的陌生人留下路标。", author: "Codex Cosmos", category: "tech" },
  { text: "不必追赶每一阵风，先确定自己的方向。", author: "Codex Cosmos", category: "life" },
  { text: "真正的效率，是减少重新进入状态的次数。", author: "深度工作", category: "life" },
];

export function quoteOfTheDay(category: "mixed" | "tech" | "philosophy"): Quote {
  const pool = category === "mixed" ? quotes : quotes.filter((quote) => quote.category === category);
  const now = new Date();
  const dayNumber = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
  return pool[Math.abs(dayNumber) % pool.length];
}
