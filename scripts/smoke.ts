import { getQuote, getFinancials, getKline } from "../src/datasource/index.ts";
import { buildReport } from "../src/analysis/report.ts";

const q = await getQuote("600519");
const fins = await getFinancials("600519", 8);
const bars = await getKline("600519", 120);
const shares = q.totalMarketCap && q.price ? q.totalMarketCap / q.price : null;

const md = buildReport({
  quote: q, financials: fins, klines: bars, shares,
  assumptions: { growthRate: 0.08, terminalGrowth: 0.025, discountRate: 0.10, years: 5 },
});
console.log("=== 研报长度:", md.length, "字符 ===\n");
console.log(md);
