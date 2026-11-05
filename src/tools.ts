/**
 * Model-facing tools.
 *
 * Every tool returns a canonical JSON value (see each `output.schema`) and a
 * short Markdown rendering for the model. Long prose belongs in `astock_report`;
 * the rest return structured data so the agent can reason over it.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { getFinancials, getKline, getQuote, searchStocks, type FinancialPeriod, type Kline, type Quote, type StockHit } from "./datasource/index.ts";
import { computeTtm, formatMoney, formatPct, impliedGrowth, pickValuationModel, runDcf, runPbRoe, type DcfAssumptions } from "./analysis/valuation.ts";
import { buildReport } from "./analysis/report.ts";

const DEFAULT_ASSUMPTIONS: DcfAssumptions = {
  growthRate: 0.08,
  terminalGrowth: 0.025,
  discountRate: 0.10,
  years: 5,
};

const text = (s: string) => [{ type: "text" as const, text: s }];

const sharesOutstanding = (q: Quote): number | null =>
  q.totalMarketCap && q.price ? q.totalMarketCap / q.price : null;

const searchTool = defineTool({
  name: "astock_search",
  description:
    "按代码、中文名称或拼音首字母检索 A 股股票，返回候选标的。查询个股前先用它确定 6 位代码。",
  parameters: {
    keyword: { type: "string", required: true, description: "关键词，如「茅台」「600519」「NDSD」" },
    limit: { type: "number", description: "返回条数上限，默认 10" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        hits: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              name: { type: "string" },
              market: { type: "string" },
              pinyin: { type: "string" },
            },
          },
        },
      },
    },
    render: (_args, value) => {
      const v = value as { query: string; hits: StockHit[] };
      return text(
        v.hits.length === 0
          ? `未找到与「${v.query}」匹配的 A 股标的`
          : `找到 ${v.hits.length} 个标的：\n` + v.hits.map((h) => `- ${h.code} ${h.name}（${h.market}）`).join("\n"),
      );
    },
  },
  async execute(args) {
    const hits = await searchStocks(args.keyword, args.limit ?? 10);
    return { query: args.keyword, hits: hits.map((h) => ({ code: h.code, name: h.name, market: h.market, pinyin: h.pinyin })) };
  },
});

const quoteTool = defineTool({
  name: "astock_quote",
  description:
    "获取单只 A 股的实时行情与估值指标：最新价、涨跌幅、总市值、PE(TTM)、PB、行业与概念标签。",
  parameters: {
    code: { type: "string", required: true, description: "6 位 A 股代码，如 600519" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" }, name: { type: "string" },
        price: { type: "number" }, prevClose: { type: "number" },
        open: { type: "number" }, high: { type: "number" }, low: { type: "number" },
        change: { type: "number" }, changePct: { type: "number" },
        turnoverRate: { type: "number" },
        totalMarketCap: { type: "number" }, floatMarketCap: { type: "number" },
        peTtm: { type: "number" }, pb: { type: "number" },
        industry: { type: "string" }, region: { type: "string" },
        source: { type: "string" }, asOf: { type: "string" },
      },
    },
    render: (_args, value) => {
      const q = value as { name: string; code: string; price: number; changePct: number; peTtm: number; pb: number; totalMarketCap: number; industry: string; source: string };
      return text([
        `${q.name}（${q.code}）${q.price} 元，${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`,
        `总市值 ${formatMoney(q.totalMarketCap, "亿元")}｜PE(TTM) ${q.peTtm > 0 ? q.peTtm.toFixed(2) : "—"}｜PB ${q.pb > 0 ? q.pb.toFixed(2) : "—"}`,
        q.industry ? `行业：${q.industry}` : "（当前数据源未返回行业标签）",
        `数据源：${q.source}`,
      ].join("\n"));
    },
  },
  async execute(args) {
    const q = await getQuote(args.code);
    const nullable = (v: number | null) => (v === null ? undefined : v);
    return {
      code: q.code, name: q.name, price: q.price, prevClose: q.prevClose,
      open: q.open, high: q.high, low: q.low, change: q.change, changePct: q.changePct,
      turnoverRate: q.turnoverRate ?? 0,
      totalMarketCap: q.totalMarketCap ?? 0, floatMarketCap: q.floatMarketCap ?? 0,
      peTtm: nullable(q.peTtm) ?? 0, pb: nullable(q.pb) ?? 0,
      industry: q.industry ?? "", region: q.region ?? "",
      source: q.source, asOf: q.asOf ?? "",
    };
  },
});

const klineTool = defineTool({
  name: "astock_kline",
  description: "获取 A 股日 K 线历史数据（前复权），用于判断趋势、区间高低点与波动。",
  parameters: {
    code: { type: "string", required: true, description: "6 位 A 股代码" },
    days: { type: "number", description: "取最近多少个交易日，默认 60，上限 250" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        days: { type: "integer" },
        bars: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              date: { type: "string" }, open: { type: "number" }, close: { type: "number" },
              high: { type: "number" }, low: { type: "number" }, volume: { type: "number" },
            },
          },
        },
      },
    },
    render: (_args, value) => {
      const v = value as { code: string; bars: Kline[] };
      const bars = v.bars ?? [];
      if (!bars.length) return text("未取到 K 线数据");
      const first = bars[0];
      const last = bars[bars.length - 1];
      const pct = ((last.close - first.close) / first.close) * 100;
      const high = Math.max(...bars.map((b) => b.high));
      const low = Math.min(...bars.map((b) => b.low));
      return text(`${v.code} 最近 ${bars.length} 个交易日（${first.date} 至 ${last.date}）：区间涨跌 ${pct.toFixed(2)}%，最高 ${high}，最低 ${low}`);
    },
  },
  async execute(args) {
    const days = Math.min(Math.max(args.days ?? 60, 5), 250);
    const bars = await getKline(args.code, days);
    return {
      code: args.code,
      days: bars.length,
      bars: bars.map((b) => ({ date: b.date, open: b.open, close: b.close, high: b.high, low: b.low, volume: b.volume })),
    };
  },
});

const financialsTool = defineTool({
  name: "astock_financials",
  description:
    "获取 A 股财报摘要：营收、归母净利、ROE、毛利率、同比增速，并折算 TTM（滚动十二个月）口径。",
  parameters: {
    code: { type: "string", required: true, description: "6 位 A 股代码" },
    periods: { type: "number", description: "取最近几个报告期，默认 8" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        ttmRevenue: { type: "number" },
        ttmNetProfit: { type: "number" },
        ttmBasis: { type: "string" },
        periods: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              reportDate: { type: "string" }, periodLabel: { type: "string" },
              revenue: { type: "number" }, netProfit: { type: "number" },
              roe: { type: "number" }, grossMargin: { type: "number" },
              revenueYoY: { type: "number" }, netProfitYoY: { type: "number" },
              basicEps: { type: "number" }, bps: { type: "number" },
            },
          },
        },
      },
    },
    render: (_args, value) => {
      const v = value as { ttmRevenue: number; ttmNetProfit: number; ttmBasis: string; periods: FinancialPeriod[] };
      const latest = (v.periods ?? [])[0];
      const head = latest
        ? `${latest.reportDate} ${latest.periodLabel}：营收 ${formatMoney(latest.revenue, "亿元")}，净利 ${formatMoney(latest.netProfit, "亿元")}，ROE ${formatPct(latest.roe)}，毛利率 ${formatPct(latest.grossMargin)}`
        : "无财报数据";
      return text([head, `TTM 营收 ${formatMoney(v.ttmRevenue, "亿元")}，TTM 净利 ${formatMoney(v.ttmNetProfit, "亿元")}（${v.ttmBasis}）`].join("\n"));
    },
  },
  async execute(args) {
    const periods = await getFinancials(args.code, args.periods ?? 8);
    const ttmNp = computeTtm(periods, "netProfit");
    const ttmRev = computeTtm(periods, "revenue");
    return {
      code: args.code,
      ttmRevenue: ttmRev.value ?? 0,
      ttmNetProfit: ttmNp.value ?? 0,
      ttmBasis: ttmNp.basis,
      periods: periods.map((p) => ({
        reportDate: p.reportDate, periodLabel: p.periodLabel,
        revenue: p.revenue ?? 0, netProfit: p.netProfit ?? 0,
        roe: p.roe ?? 0, grossMargin: p.grossMargin ?? 0,
        revenueYoY: p.revenueYoY ?? 0, netProfitYoY: p.netProfitYoY ?? 0,
        basicEps: p.basicEps ?? 0, bps: p.bps ?? 0,
      })),
    };
  },
});

const valuationTool = defineTool({
  name: "astock_valuation",
  description:
    "对单只 A 股做估值测算。会自动选择模型：非金融类用两阶段 DCF，银行/保险/证券用 PB-ROE。返回内在价值、相对现价的溢价/折价，以及现价隐含的增速。",
  parameters: {
    code: { type: "string", required: true, description: "6 位 A 股代码" },
    growthRate: { type: "number", description: "DCF 前 N 年净利润增速，默认 0.08（8%）" },
    terminalGrowth: { type: "number", description: "永续增速，默认 0.025" },
    discountRate: { type: "number", description: "折现率/要求回报率，默认 0.10" },
    years: { type: "number", description: "DCF 显式预测年数，默认 5" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" }, name: { type: "string" },
        price: { type: "number" },
        model: { type: "string" }, modelReason: { type: "string" },
        fairValuePerShare: { type: "number" },
        upsidePct: { type: "number" },
        impliedGrowthPct: { type: "number" },
        basis: { type: "string" },
      },
    },
    render: (_args, value) => {
      const v = value as {
        name: string; code: string; price: number; model: string;
        fairValuePerShare: number; upsidePct: number; impliedGrowthPct: number; basis: string;
      };
      return text([
        `${v.name}（${v.code}）现价 ${v.price} 元，模型：${v.model}`,
        v.fairValuePerShare > 0
          ? `内在价值 ${v.fairValuePerShare.toFixed(2)} 元，${v.upsidePct >= 0 ? "低估" : "高估"} ${Math.abs(v.upsidePct).toFixed(1)}%`
          : "无法给出内在价值",
        v.impliedGrowthPct !== -999 ? `当前股价隐含 5 年增速 ${v.impliedGrowthPct.toFixed(1)}%` : "",
        v.basis,
      ].filter(Boolean).join("\n"));
    },
  },
  async execute(args) {
    const assumptions: DcfAssumptions = {
      growthRate: args.growthRate ?? DEFAULT_ASSUMPTIONS.growthRate,
      terminalGrowth: args.terminalGrowth ?? DEFAULT_ASSUMPTIONS.terminalGrowth,
      discountRate: args.discountRate ?? DEFAULT_ASSUMPTIONS.discountRate,
      years: Math.max(1, Math.round(args.years ?? DEFAULT_ASSUMPTIONS.years)),
    };
    const [q, fins] = await Promise.all([getQuote(args.code), getFinancials(args.code, 8)]);
    const shares = sharesOutstanding(q);
    const ttmNp = computeTtm(fins, "netProfit");
    const latest = fins[0];
    const choice = pickValuationModel(q.name, q.industry, ttmNp.value);

    let fairValuePerShare = 0;
    let basis = choice.reason;
    let impliedGrowthPct = -999;

    if (choice.model === "dcf") {
      const dcf = runDcf(ttmNp.value, shares, assumptions);
      fairValuePerShare = dcf.fairValuePerShare ?? 0;
      basis = dcf.basis;
      const ig = impliedGrowth(q.price, ttmNp.value, shares, assumptions);
      if (ig !== null) impliedGrowthPct = ig * 100;
    } else if (choice.model === "pb-roe") {
      const pb = runPbRoe(latest?.bps ?? null, latest?.roe ?? null, {
        requiredReturn: assumptions.discountRate,
        sustainableGrowth: assumptions.terminalGrowth,
      });
      fairValuePerShare = pb.fairValuePerShare ?? 0;
      basis = pb.basis;
    }

    return {
      code: q.code, name: q.name, price: q.price,
      model: choice.model, modelReason: choice.reason,
      fairValuePerShare,
      upsidePct: fairValuePerShare > 0 ? ((fairValuePerShare - q.price) / q.price) * 100 : 0,
      impliedGrowthPct,
      basis,
    };
  },
});

const reportTool = defineTool({
  name: "astock_report",
  description:
    "生成一只 A 股的完整研究简报（Markdown）：行情快照、经营质量、估值测算、价格走势与风险提示。这是给用户看的成品，其他工具用于自己取数分析。",
  parameters: {
    code: { type: "string", required: true, description: "6 位 A 股代码" },
    growthRate: { type: "number", description: "净利润增速假设，默认 0.08" },
    discountRate: { type: "number", description: "折现率假设，默认 0.10" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" }, name: { type: "string" },
        markdown: { type: "string" },
        source: { type: "string" },
      },
    },
    render: (_args, value) => text((value as { markdown: string }).markdown),
  },
  async execute(args) {
    const [q, fins, bars] = await Promise.all([
      getQuote(args.code),
      getFinancials(args.code, 8),
      getKline(args.code, 120).catch(() => [] as Kline[]),
    ]);
    const markdown = buildReport({
      quote: q,
      financials: fins,
      klines: bars,
      shares: sharesOutstanding(q),
      assumptions: {
        growthRate: args.growthRate ?? DEFAULT_ASSUMPTIONS.growthRate,
        terminalGrowth: DEFAULT_ASSUMPTIONS.terminalGrowth,
        discountRate: args.discountRate ?? DEFAULT_ASSUMPTIONS.discountRate,
        years: DEFAULT_ASSUMPTIONS.years,
      },
    });
    return { code: q.code, name: q.name, markdown, source: q.source };
  },
});

/** All tools this plugin contributes. */
export const astockTools = [searchTool, quoteTool, klineTool, financialsTool, valuationTool, reportTool];

export type { FinancialPeriod };
