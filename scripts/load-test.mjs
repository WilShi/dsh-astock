import { name, inject, apply } from "../lib/index.js";

console.log("plugin name:", name);
console.log("inject:", JSON.stringify(inject));

const registered = [];
const ctx = { tools: { register: (t) => { registered.push(t); return () => {}; } } };
apply(ctx);

console.log("\n注册工具数:", registered.length);
for (const t of registered) {
  const props = Object.keys(t.parameters?.properties ?? {});
  const required = t.parameters?.required ?? [];
  console.log(` - ${t.name}`);
  console.log(`   参数: ${props.join(", ")} | 必填: ${required.join(", ") || "无"}`);
  console.log(`   输出根类型: ${t.output?.schema?.type}`);
}

// 真实跑一个工具，验证返回结构能通过 output.schema 的形状
const search = registered.find((t) => t.name === "astock_search");
const exec = { signal: AbortSignal.timeout(20000), agent: null, callId: "t1", name: "astock_search", arguments: {} };
const result = await search.execute({ keyword: "茅台" }, exec);
console.log("\nastock_search 实际返回:", JSON.stringify(result));

const quote = registered.find((t) => t.name === "astock_quote");
const q = await quote.execute({ code: "600519" }, exec);
console.log("astock_quote 实际返回 name/price/source:", q.name, q.price, q.source);

const report = registered.find((t) => t.name === "astock_report");
const rep = await report.execute({ code: "600519" }, exec);
console.log("astock_report 生成的 markdown 长度:", rep.markdown.length);