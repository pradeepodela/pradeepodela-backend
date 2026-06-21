import dotenv from 'dotenv';
import path from 'path';

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { db } from './config/firebase';
import { createNote, getNotes, updateNote, deleteNote } from './services/notesService';
import { validateApiKey } from './services/apiKeyService';

/* ----------------------------------------------------------
   AUTH
   User generates a key in VoiceFlow Settings → copies it here.
   Add to your MCP client config:  VOICEFLOW_API_KEY=vf_xxx...
---------------------------------------------------------- */
const API_KEY = process.env.VOICEFLOW_API_KEY;

if (!API_KEY) {
    console.error('[VoiceFlow MCP] Missing VOICEFLOW_API_KEY.');
    console.error('[VoiceFlow MCP] Open VoiceFlow → Settings → API Keys → Generate a key.');
    process.exit(1);
}

/* ----------------------------------------------------------
   HELPERS
---------------------------------------------------------- */

const stripHtml = (html: string) =>
    (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const formatNote = (note: any, includeContent = false) => {
    const date = new Date(note.updatedAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
    });
    const tags = note.tags?.length ? `Tags: ${note.tags.join(', ')}` : '';
    const keywords = note.aiKeywords?.length ? `Keywords: ${note.aiKeywords.join(', ')}` : '';
    const meta = [date, tags, keywords].filter(Boolean).join(' · ');
    const content = includeContent ? `\n\n${stripHtml(note.text)}` : '';
    return `[${note.id}] ${note.title || 'Untitled'}\n${meta}${content}`;
};

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: `Error: ${msg}` }] });

/* ----------------------------------------------------------
   MCP SERVER
---------------------------------------------------------- */
const server = new Server(
    { name: 'voiceflow-notes', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

/* ---------- TOOL DEFINITIONS ---------- */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'create_note',
            description:
                'Create a new note in VoiceFlow Notes. Use this when the user says "save this", "create a note about X", or "note this down".',
            inputSchema: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'A clear, short title (3–7 words)',
                    },
                    content: {
                        type: 'string',
                        description: 'The full note content as plain text',
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional topic tags e.g. ["ideas", "work"]',
                    },
                },
                required: ['title', 'content'],
            },
        },
        {
            name: 'list_notes',
            description:
                'List the most recent notes from VoiceFlow. Use when the user asks "what did I write?" or "show my recent notes".',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: 'Number of notes to return. Default 10, max 50.',
                    },
                },
            },
        },
        // {
        //     name: 'search_notes',
        //     description:
        //         'Search notes by keyword — matches title, content, tags, and AI keywords. Use when the user asks about a specific topic from their notes.',
        //     inputSchema: {
        //         type: 'object',
        //         properties: {
        //             query: {
        //                 type: 'string',
        //                 description: 'The topic or keyword to search for',
        //             },
        //         },
        //         required: ['query'],
        //     },
        // },
        {
            name: 'get_note',
            description: 'Read the full content of a single note by its ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'The note ID shown in [brackets] in list/search results',
                    },
                },
                required: ['id'],
            },
        },
        {
            name: 'append_to_note',
            description:
                'Add new content to the end of an existing note. Use when the user says "add this to my note about X".',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'The note ID to append to',
                    },
                    content: {
                        type: 'string',
                        description: 'The text to add at the end',
                    },
                },
                required: ['id', 'content'],
            },
        },
        {
            name: 'delete_note',
            description:
                'Permanently delete a note. Always confirm with the user before calling this.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'The note ID to delete',
                    },
                },
                required: ['id'],
            },
        },
    ],
}));

/* ---------- TOOL EXECUTION ---------- */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const userId = (server as any)._userId as string;

    try {
        switch (name) {

            case 'create_note': {
                const { title, content, tags = [] } = args as {
                    title: string; content: string; tags?: string[];
                };
                if (!title?.trim()) return err('title is required');
                if (!content?.trim()) return err('content is required');

                const note = await createNote(userId, {
                    title: title.trim(),
                    text: `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>`,
                    tags,
                    folderId: null,
                });
                return ok(`Note saved to VoiceFlow.\nTitle: "${note.title}"\nID: ${note.id}`);
            }

            case 'list_notes': {
                const { limit = 10 } = (args || {}) as { limit?: number };
                const cap = Math.min(Number(limit) || 10, 50);
                const notes = await getNotes(userId);
                const slice = notes.slice(0, cap);
                if (slice.length === 0) return ok('No notes found.');
                const body = slice.map((n: any) => formatNote(n)).join('\n\n');
                return ok(`Your ${slice.length} most recent notes:\n\n${body}`);
            }

            case 'search_notes': {
                const { query } = args as { query: string };
                if (!query?.trim()) return err('query is required');

                const notes = await getNotes(userId);
                const q = query.toLowerCase().trim();

                const matches = notes.filter((n: any) => {
                    const title = (n.title || '').toLowerCase();
                    const text = stripHtml(n.text || '').toLowerCase();
                    const tags = (n.tags || []).join(' ').toLowerCase();
                    const keywords = (n.aiKeywords || []).join(' ').toLowerCase();
                    return title.includes(q) || text.includes(q) || tags.includes(q) || keywords.includes(q);
                });

                if (matches.length === 0) return ok(`No notes found matching "${query}".`);

                const body = matches.slice(0, 8).map((n: any) => {
                    const preview = stripHtml(n.text || '').slice(0, 200);
                    const previewText = preview ? `\n  "${preview}${preview.length === 200 ? '…' : ''}"` : '';
                    return formatNote(n) + previewText;
                }).join('\n\n');

                return ok(`Found ${matches.length} note(s) matching "${query}":\n\n${body}`);
            }

            case 'get_note': {
                const { id } = args as { id: string };
                if (!id?.trim()) return err('id is required');

                const doc = await db.collection('notes').doc(id.trim()).get();
                if (!doc.exists) return ok(`Note not found: ${id}`);

                const data = doc.data() as any;
                if (data.userId !== userId) return err('Access denied.');

                const note = {
                    id: doc.id, ...data,
                    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt,
                };
                return ok(formatNote(note, true));
            }

            case 'append_to_note': {
                const { id, content } = args as { id: string; content: string };
                if (!id?.trim() || !content?.trim()) return err('id and content are required');

                const doc = await db.collection('notes').doc(id.trim()).get();
                if (!doc.exists) return ok(`Note not found: ${id}`);

                const data = doc.data() as any;
                if (data.userId !== userId) return err('Access denied.');

                const newText = (data.text || '') + `\n<p>${content.trim()}</p>`;
                await updateNote(userId, id.trim(), { text: newText });
                return ok(`Added to "${data.title || 'Untitled'}" successfully.`);
            }

            case 'delete_note': {
                const { id } = args as { id: string };
                if (!id?.trim()) return err('id is required');

                const doc = await db.collection('notes').doc(id.trim()).get();
                if (!doc.exists) return ok(`Note not found: ${id}`);

                const data = doc.data() as any;
                if (data.userId !== userId) return err('Access denied.');

                await deleteNote(userId, id.trim());
                return ok(`Note "${data.title || 'Untitled'}" deleted.`);
            }

            default:
                return err(`Unknown tool: ${name}`);
        }
    } catch (error: any) {
        console.error(`[MCP] Error in "${name}":`, error);
        return err(error.message || 'Something went wrong');
    }
});

/* ----------------------------------------------------------
   START — validate API key first, then begin serving
---------------------------------------------------------- */
async function main() {
    console.error('[VoiceFlow MCP] Validating API key…');

    const userId = await validateApiKey(API_KEY!);
    if (!userId) {
        console.error('[VoiceFlow MCP] Invalid API key. Generate a new one in VoiceFlow → Settings → API Keys.');
        process.exit(1);
    }

    (server as any)._userId = userId;

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('[VoiceFlow MCP] Ready. Your notes are connected.');
}

main().catch((error) => {
    console.error('[VoiceFlow MCP] Fatal error:', error);
    process.exit(1);
});
