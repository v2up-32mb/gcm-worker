export const meta = { name: "probe_models", description: "校验评审可用模型与 schema" };

const MODEL = args && args.model ? args.model : "oc2api/big-pickle";

const r = await agent(
  "只输出 JSON：{\"ok\": true, \"model\": \"<你被路由到的模型名，若未知写 unknown>\"}",
  { label: "probe", model: MODEL, schema: { type: "object", properties: { ok: { type: "boolean" }, model: { type: "string" } }, required: ["ok", "model"] } },
);
return { requested: MODEL, result: r };
