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
  content: [{ type: 'text', text: `搜索「${query}」的结果:黑猫今天心情很好。` }],
}));

server.registerTool('get_time', {
  description: '获取当前服务器时间',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: new Date().toISOString() }],
}));

await server.connect(new StdioServerTransport());
