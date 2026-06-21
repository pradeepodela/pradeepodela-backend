import { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { validateApiKey } from '../services/apiKeyService';
import { buildMcpServer } from '../mcp/server';

const router = Router();

/* ----------------------------------------------------------
   Resolve API key from request headers.
   Accepts:
     - x-api-key: vf_xxx
     - Authorization: Bearer vf_xxx
     - ?key=vf_xxx  (query param fallback)
---------------------------------------------------------- */
function extractApiKey(req: Request): string | null {
    const fromHeader = req.headers['x-api-key'] as string
        || (req.headers.authorization?.startsWith('Bearer ')
            ? req.headers.authorization.slice(7)
            : undefined);
    const fromQuery = req.query.key as string;
    return fromHeader || fromQuery || null;
}

/* ----------------------------------------------------------
   POST /api/mcp
   Main MCP endpoint — stateless, one server per request.
   Each request is independently authenticated.
---------------------------------------------------------- */
router.post('/', async (req: Request, res: Response) => {
    try {
        const apiKey = extractApiKey(req);

        if (!apiKey) {
            res.status(401).json({
                error: 'Missing API key.',
                hint: 'Add header: x-api-key: vf_your_key_here',
            });
            return;
        }

        const userId = await validateApiKey(apiKey);

        if (!userId) {
            res.status(401).json({
                error: 'Invalid or revoked API key.',
                hint: 'Generate a new key in VoiceFlow → Settings → API Keys.',
            });
            return;
        }

        // Build a fresh MCP server + stateless transport for this request
        const mcpServer = buildMcpServer(userId);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless — no session state between requests
        });

        // Clean up when request ends
        res.on('close', async () => {
            await transport.close();
            await mcpServer.close();
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);

    } catch (error: any) {
        console.error('[MCP HTTP] Unhandled error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});

/* ----------------------------------------------------------
   GET /api/mcp
   Some clients probe with GET first. Return a clear message.
---------------------------------------------------------- */
router.get('/', (_req: Request, res: Response) => {
    res.json({
        name: 'VoiceFlow Notes MCP Server',
        version: '1.0.0',
        transport: 'streamable-http',
        endpoint: 'POST /api/mcp',
        auth: 'x-api-key header or Authorization: Bearer <key>',
        docs: 'Generate your API key in VoiceFlow → Settings → API Keys',
    });
});

export default router;
