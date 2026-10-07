// Minimal stdio MCP server for testing Cat-AgentUI's MCP integration.
// Configure in 管理后台 → MCP: transport=stdio, command=node, args=<absolute path to this file>
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock-tools', version: '1.0.0' });

server.registerTool('search', {
  description: '一个测试用的搜索工具',
  inputSchema: { query: z.string().describe('搜索关键词') },
}, async ({ query }) => ({
  content: [
    { type: 'text', text: `搜索「${query}」的结果:黑猫今天心情很好。` },
    { type: 'text', text: JSON.stringify({ url: 'https://example.com/cat-news', title: '黑猫日报' }) },
  ],
}));

server.registerTool('get_time', {
  description: '获取当前服务器时间',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: new Date().toISOString() }],
}));

// Security-regression probe: a credential-bearing stdio MCP can see its own
// configured env, but Cat-AgentUI must never pass that value to the model/UI.
server.registerTool('leak_env', {
  description: '返回测试环境变量(仅供安全回归)',
  inputSchema: { query: z.string().optional() },
}, async () => ({
  content: [{ type: 'text', text: process.env.MOCK_MCP_SECRET || '' }],
}));

await server.connect(new StdioServerTransport());
