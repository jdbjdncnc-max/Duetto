// Entangle owns pricing, credentials and the daily wallet for both services.
// There is deliberately no direct-provider fallback on budget/network failure.
export function sharedBudgetTarget(ai, env = process.env) {
  const explicit = String(env.DUETTO_BUDGET_URL || '').trim();
  const context = String(ai.context_url || '').trim();
  if (!explicit && !context) throw Object.assign(new Error('请先配置 Entangle 上下文地址，让共读与聊天共用每日 $3 预算。'), {status:503});
  const url = new URL(explicit || context);
  if (!explicit) url.pathname = '/api/budget/duetto-completion';
  url.search = ''; url.hash = '';
  const key = String(env.DUETTO_BUDGET_KEY || ai.context_key || '').trim();
  if (!key) throw Object.assign(new Error('缺少 Entangle 网关密钥，无法使用共享预算。'), {status:503});
  return {url:url.toString(), key};
}
