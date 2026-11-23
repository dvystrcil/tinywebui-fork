import type { McpServerSpec } from './config/config.ts';

/**
 * `hiddenTools` on a server's spec: tools from that server the deployment
 * never offers. It travels with the server's definition, so it is not the
 * global disabledTools: a key set in code is locked in the page, and a
 * code-set disabledTools would make every tool switch in the composer fail.
 * Names are the server's own, without the `server__` prefix.
 */
export function hiddenToolsProblems(name: string, spec: McpServerSpec): string[] {
  const hidden = spec.hiddenTools as unknown;
  if (hidden === undefined) return [];
  const ok = Array.isArray(hidden) && hidden.every((t) => typeof t === 'string' && t.trim());
  return ok ? [] : [`mcpServers.${name}.hiddenTools must be a list of tool names`];
}

/** True when `spec` hides the server's tool `tool`. */
export function isHidden(spec: McpServerSpec | undefined, tool: string): boolean {
  return Array.isArray(spec?.hiddenTools) && (spec.hiddenTools as unknown[]).includes(tool);
}
