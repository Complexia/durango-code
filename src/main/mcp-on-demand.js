// ---------------------------------------------------------------------------
// MCP servers on demand for the providers that run Durango Code's `orion`
// bridge (Codex, Cursor, Grok, Kimi, OpenCode, Muse, fx, ...).
//
// The MCP servers connected to Durango Code and the Durango account's
// connectors (Notion, Gmail, ...) used to go into each provider's own MCP
// config, so the provider connected every one of them before the turn could
// start, and listed all their tools, even when the task needed none. Now they
// stay out of the provider's config. The bridge offers two tools instead:
// `load_tools` connects the apps a task needs (here, in Durango Code) and
// returns their tools; `call_app_tool` calls one. Nothing connects until the
// agent asks, and a slow or failing server only fails its own load.
//
// Claude sessions load servers natively mid-turn instead (claude-driver.js).
// ---------------------------------------------------------------------------

import { app } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { shellPathSyncPromise } from './shell-env.js';

export const LOAD_TOOLS_TOOL_NAME = 'load_tools';
export const CALL_APP_TOOL_NAME = 'call_app_tool';
export const ON_DEMAND_MCP_TOOL_NAMES = Object.freeze([LOAD_TOOLS_TOOL_NAME, CALL_APP_TOOL_NAME]);

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_TOOLS_PER_APP = 500;

const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const errorText = (error) => String(error?.message ?? error ?? 'Unknown error').slice(0, 300);

/** The bridge's tool definitions (MCP tools/list shape) for a run with `names` loadable. */
export const onDemandMcpToolDefinitions = (names = []) =>
  names.length === 0
    ? []
    : [
        {
          name: LOAD_TOOLS_TOOL_NAME,
          description:
            `Load the tools of an app the user connected (an MCP server such as Notion or Gmail). Apps you can load: ${names.join(', ')}. ` +
            `Their tools are not loaded until you load the app, so load one only when the task needs it. ` +
            `Returns each tool's name, description and input schema; call them with ${CALL_APP_TOOL_NAME}.`,
          inputSchema: {
            type: 'object',
            properties: {
              apps: {
                type: 'array',
                items: { type: 'string' },
                description: 'Names of the apps to load. Omit to list the apps that can be loaded.',
              },
            },
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: CALL_APP_TOOL_NAME,
          description: `Call a tool of an app loaded with ${LOAD_TOOLS_TOOL_NAME}. Pass the app, the tool's name and its arguments as described by its input schema. A secret ref from request_secret (\`dsr_…\`) anywhere in the arguments is replaced by the secret, and the result comes back with it replaced by [secret].`,
          inputSchema: {
            type: 'object',
            properties: {
              app: { type: 'string', description: 'The app (as passed to load_tools)' },
              tool: { type: 'string', description: "The tool's name, as load_tools returned it" },
              arguments: { type: 'object', description: "The tool's arguments", additionalProperties: true },
            },
            required: ['app', 'tool'],
          },
        },
      ];

const defaultConnect = async (server) => {
  const client = new Client({ name: 'Durango Code', version: app.getVersion() });
  let transport;
  if (server.transport === 'stdio') {
    await shellPathSyncPromise;
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...process.env, ...(server.env ?? {}) },
      ...(server.cwd ? { cwd: server.cwd } : {}),
      stderr: 'ignore',
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    });
  }
  await client.connect(transport);
  return client;
};

const listAllTools = async (client) => {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools ?? []));
    cursor = page.nextCursor;
  } while (cursor && tools.length < MAX_TOOLS_PER_APP);
  return tools;
};

/**
 * One run's loadable servers (resolved entries: `{ name, transport, url,
 * headers }` or `{ name, transport: 'stdio', command, args, env, cwd }`).
 * Connections are made on first load and closed with `close()`.
 */
export const createOnDemandMcps = (servers = [], { connect = defaultConnect, timeoutMs = CONNECT_TIMEOUT_MS } = {}) => {
  const byName = new Map();
  for (const server of Array.isArray(servers) ? servers : []) {
    if (server?.name && !byName.has(server.name)) byName.set(server.name, server);
  }
  const loaded = new Map(); // name -> Promise<{ client, tools }>
  let closed = false;

  const names = () => [...byName.keys()];

  const connectApp = (name) => {
    let pending = loaded.get(name);
    if (!pending) {
      pending = (async () => {
        let client;
        try {
          client = await withTimeout(connect(byName.get(name)), timeoutMs, 'Timed out connecting.');
          const tools = await withTimeout(listAllTools(client), timeoutMs, 'Timed out listing tools.');
          if (closed) throw new Error('The run ended.');
          return { client, tools };
        } catch (error) {
          await client?.close?.().catch(() => {});
          throw error;
        }
      })();
      loaded.set(name, pending);
      // A failed connection is retried by the next load.
      pending.catch(() => {
        if (loaded.get(name) === pending) loaded.delete(name);
      });
    }
    return pending;
  };

  const appName = (value) => String(value ?? '').trim().replace(/^@/, '');

  /** load_tools: resolves (never rejects) with `{ ok, text }`. */
  const load = async (args = {}) => {
    const requested = [...new Set((Array.isArray(args.apps) ? args.apps : []).map(appName).filter(Boolean))];
    if (requested.length === 0) {
      return { ok: true, text: `Apps you can load: ${names().join(', ') || 'none'}.` };
    }
    const unknown = requested.filter((name) => !byName.has(name));
    const results = await Promise.all(
      requested
        .filter((name) => byName.has(name))
        .map(async (name) => {
          try {
            const { tools } = await connectApp(name);
            return { name, tools };
          } catch (error) {
            return { name, error: errorText(error) };
          }
        })
    );
    const apps = results.map((result) =>
      result.error
        ? { app: result.name, error: result.error }
        : {
            app: result.name,
            tools: result.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema ?? { type: 'object' },
            })),
          }
    );
    const payload = {
      apps,
      ...(unknown.length > 0 ? { notConnected: unknown, available: names() } : {}),
      note: apps.some((entry) => entry.tools)
        ? `Call these tools with ${CALL_APP_TOOL_NAME} ({ app, tool, arguments }).`
        : 'No tools loaded.',
    };
    return { ok: apps.some((entry) => entry.tools), text: JSON.stringify(payload, null, 2) };
  };

  /** call_app_tool: resolves with `{ ok, text, content? }`. */
  const call = async (args = {}, { accessMode = 'full-access' } = {}) => {
    const name = appName(args.app);
    const toolName = String(args.tool ?? '').trim();
    if (!byName.has(name)) {
      return { ok: false, text: `Not connected: ${name || '(no app)'}. Apps you can load: ${names().join(', ') || 'none'}.` };
    }
    if (!toolName) return { ok: false, text: `${CALL_APP_TOOL_NAME} requires a \`tool\`.` };
    // Read only must not act; the user's servers are not known to be safe.
    if (accessMode === 'read-only') {
      return { ok: false, text: `Read only: tools of connected apps (${name}) can't be called. Ask the user to switch the access mode.` };
    }
    let connection;
    try {
      connection = await connectApp(name);
    } catch (error) {
      return { ok: false, text: `Could not connect ${name}: ${errorText(error)}` };
    }
    if (!connection.tools.some((tool) => tool.name === toolName)) {
      return {
        ok: false,
        text: `${name} has no tool named ${toolName}. Its tools: ${connection.tools.map((tool) => tool.name).join(', ')}.`,
      };
    }
    const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {};
    try {
      const result = await connection.client.callTool({ name: toolName, arguments: toolArgs });
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return {
        ok: !result?.isError,
        text: text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : '(no output)'),
        ...(content.length > 0 ? { content } : {}),
      };
    } catch (error) {
      return { ok: false, text: `${name}.${toolName} failed: ${errorText(error)}` };
    }
  };

  const close = async () => {
    closed = true;
    const pending = [...loaded.values()];
    loaded.clear();
    await Promise.all(
      pending.map((entry) => entry.then(({ client }) => client.close().catch(() => {}), () => {}))
    );
  };

  return { names, load, call, close };
};
