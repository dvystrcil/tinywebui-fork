import { json, readJson, oneOf } from '../http.ts';
import { isClosed, enabledEntries, publicEntry, findConnector, findEntry } from '../config/models.ts';
import { modelsFor, SECRET_PATCH_KEYS } from '../access/policy.ts';
import { audit } from '../audit.ts';
import { setOverride } from '../config/approval.ts';
import { actor } from '../access/auth_gate.ts';
import { FEATURE } from '../../shared/features.ts';
import type { Route, RouteDeps } from './types.ts';
import type { McpHub } from '../mcp.ts';
import type { ConfigReply, ToolBrief } from '../../shared/api.ts';

interface ProviderModel { id: string; name: string | null }
interface ModelList { supported: boolean; models: ProviderModel[]; error?: string }

export const toolList = (hub: McpHub): ToolBrief[] => hub.tools.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters
}));

export function settingsRoutes({ config, configFor, hub, modelFor, saveConfig, store, toolsView }: Pick<RouteDeps, 'config' | 'configFor' | 'hub' | 'modelFor' | 'saveConfig' | 'store' | 'toolsView'>): Route[] {
  // A workspace is a model catalog entry, named by its id (as a turn's run
  // names it); null for a name the catalog does not know.
  const workspaceOf = (key: unknown): string | null => {
    if (typeof key !== 'string' || !key) return null;
    const cfg = config();
    return findEntry(cfg, key)?.id ?? (key === cfg.model ? key : null);
  };
  // The provider's model list, cached per endpoint for a few minutes:
  // OpenRouter's list is large and the picker is opened far more often than
  // the catalogue changes.
  let modelCache: { key: string; at: number; value: ModelList } | null = null;
  const listModels = async (): Promise<ModelList> => {
    const cfg = config();
    const key = `${cfg.baseUrl}|${Boolean(cfg.apiKey)}`;
    if (modelCache?.key === key && Date.now() - modelCache.at < 5 * 60_000) return modelCache.value;
    let value: ModelList;
    try {
      const r = await fetch(`${cfg.baseUrl}/models`, {
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) throw new Error(`${r.status} from ${cfg.baseUrl}/models`);
      const body: any = await r.json();
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      const models = rows
        .map((m: any): ProviderModel => ({ id: m.id || m.name, name: m.name && m.name !== m.id ? m.name : null }))
        .filter((m: ProviderModel) => typeof m.id === 'string' && m.id)
        .sort((a: ProviderModel, b: ProviderModel) => a.id.localeCompare(b.id));
      value = { supported: models.length > 0, models };
    } catch (err) {
      value = { supported: false, models: [], error: err.message };
    }
    modelCache = { key, at: Date.now(), value };
    return value;
  };

  return [
    { method: 'GET', path: /^\/api\/config$/, feature: null, handle: ({ res, auth }) => json(res, 200, {
      ...configFor(auth),
      tools: toolList(hub()),
      mcpErrors: hub().errors
    } satisfies ConfigReply) },

    { method: 'POST', path: /^\/api\/config$/, feature: FEATURE.SETTINGS, handle: async ({ req, res, auth }) => {
      const patch = await readJson(req);
      // Credentials and routing: the sole user or an admin, not any role that
      // was merely granted the settings feature.
      const secret = Object.keys(patch).filter((k) => SECRET_PATCH_KEYS.has(k));
      if (secret.length && !auth.isAdmin) return json(res, 403, { error: `only an admin can change: ${secret.join(', ')}` });
      saveConfig(patch, actor(auth));
      audit('admin.config_changed', { by: auth.userId ?? null });
      return json(res, 200, configFor(auth));
    } },

    // The provider's own model list, for the composer's model picker. Not
    // every OpenAI-compatible endpoint serves /models, so a failure is an
    // answer too: the picker falls back to typing an id.
    { method: 'GET', path: /^\/api\/models$/, feature: FEATURE.MODEL_PICKER, handle: async ({ res, auth }) => {
      const cfg = config();
      const allowed = modelsFor(cfg, auth.role);
      // A catalog is the whole list: its labels, never the provider's ids.
      if (isClosed(cfg)) {
        const entries = enabledEntries(cfg).filter((e) => allowed === '*' || allowed.includes(e.id));
        return json(res, 200, { supported: true, restricted: true, catalog: true, models: entries.map(publicEntry) });
      }
      const all = await listModels();
      if (allowed === '*') return json(res, 200, all);
      // A fixed catalog: only those ids, named from the provider list when
      // it knows them, listed even when it does not.
      const byId = new Map(all.models.map((m) => [m.id, m]));
      return json(res, 200, { supported: true, restricted: true, models: allowed.map((id) => byId.get(id) || { id, name: null }) });
    } },

    // "Test connection" for the connector editor. A key typed into the form is
    // used as is; a blank one means the stored key of that connector ('default'
    // is the top-level baseUrl/apiKey), since the page never holds keys.
    { method: 'POST', path: /^\/api\/connectors\/test$/, feature: FEATURE.SETTINGS, handle: async ({ req, res, auth }) => {
      if (!auth.isAdmin) return json(res, 403, { error: 'only an admin can test connectors' });
      const body = await readJson(req);
      const cfg = config();
      const text = (v: unknown) => (typeof v === 'string' ? v : '');
      const stored = text(body.id) && body.id !== 'default' ? findConnector(cfg, text(body.id)) : { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey };
      const baseUrl = String(text(body.baseUrl) || stored?.baseUrl || '').replace(/\/+$/, '');
      const apiKey = text(body.apiKey) || stored?.apiKey || '';
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      try {
        const r = await fetch(`${baseUrl}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(8000)
        });
        if (r.status === 401 || r.status === 403) return json(res, 200, { ok: false, error: `${r.status}: the endpoint rejected the key` });
        // Not every OpenAI-compatible server lists models; reachable is the point.
        const list: any = r.ok ? await r.json().catch(() => null) : null;
        const rows = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : null;
        return json(res, 200, { ok: r.status < 500, status: r.status, models: rows ? rows.length : null });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    } },

    // The grouped view behind the tools panel: built-ins, and every MCP
    // server's tools under it with that server's connection health.
    // `?workspace=`: the person's switches for that workspace (the composer's
    // model); without it, for the model their new chats start on.
    { method: 'GET', path: /^\/api\/tools$/, feature: FEATURE.TOOLS, handle: ({ res, auth, url }) => {
      if (!auth.user) return json(res, 200, toolsView());
      const workspace = workspaceOf(url.searchParams.get('workspace') || modelFor(auth.user.id, auth.role, null));
      return json(res, 200, { ...toolsView(), mcpOff: workspace ? store.users.mcpOff(auth.user.id, workspace) : [] });
    } },

    // The composer's server switch, per person and per workspace: off for this
    // person's turns in that workspace only, on top of what its model is scoped
    // to. It changes no deployment config, so it works where MCP servers are set in code.
    { method: 'POST', path: /^\/api\/me\/mcp$/, feature: FEATURE.TOOLS, handle: async ({ req, res, auth }) => {
      if (!auth.user) return json(res, 400, { error: 'server choices are per person; sign in, or switch the server off for everyone on the MCP page' });
      const { server, off, workspace: asked } = await readJson(req);
      if (typeof server !== 'string' || typeof off !== 'boolean' || typeof asked !== 'string' || !asked) {
        return json(res, 400, { error: 'server (a name), off (true or false) and workspace (a model id) are required' });
      }
      if (!hub().servers[server]) return json(res, 404, { error: `no such server "${server}"` });
      const workspace = workspaceOf(asked);
      if (!workspace) return json(res, 404, { error: `no such workspace "${asked}"` });
      const set = new Set(store.users.mcpOff(auth.user.id, workspace));
      if (off) set.add(server); else set.delete(server);
      return json(res, 200, { mcpOff: store.users.setMcpOff(auth.user.id, workspace, [...set]) });
    } },

    // Per-tool approval override from the settings panel: 'ask', 'auto', or
    // 'default' to fall back to the global toolApproval mode.
    { method: 'POST', path: /^\/api\/tools\/approval$/, feature: FEATURE.TOOLS, handle: async ({ req, res, auth }) => {
      const { name, policy } = await readJson(req);
      if (typeof name !== 'string' || !name || !oneOf(policy, ['ask', 'auto', 'default'] as const)) {
        return json(res, 400, { error: 'name and policy (ask | auto | default) are required' });
      }
      saveConfig(setOverride(config(), name, policy), actor(auth));
      return json(res, 200, toolsView());
    } },

    { method: 'POST', path: /^\/api\/tools\/toggle$/, feature: FEATURE.TOOLS, handle: async ({ req, res, auth }) => {
      const { name, disabled } = await readJson(req);
      if (typeof name !== 'string' || !name) return json(res, 400, { error: 'name is required' });
      const set = new Set(config().disabledTools || []);
      if (disabled) set.add(name); else set.delete(name);
      saveConfig({ disabledTools: [...set] }, actor(auth));
      return json(res, 200, toolsView());
    } }
  ];
}
