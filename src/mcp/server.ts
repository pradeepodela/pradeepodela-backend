import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { db } from '../config/firebase';
import { createNote, updateNote, deleteNote, searchNotes } from '../services/notesService';
import { buildKeywordGraph, buildGraphFromNotes, getRelatedConcepts, analyzePatterns } from '../services/graphService';
import { getFolders, buildFolderTree } from '../services/foldersService';
import { hybridSearchNotes, suggestRelatedNotes } from '../services/retrievalService';

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
   BUILD MCP SERVER
   Called once per HTTP request (stateless mode).
   Pass the userId resolved from the API key.
---------------------------------------------------------- */
export function buildMcpServer(userId: string): Server {
    const server = new Server(
        { name: 'voiceflow-notes', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    /* ---------- TOOL DEFINITIONS ---------- */
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'create_note',
                description: 'Create a new note in VoiceFlow Notes. Use when the user says "save this", "create a note about X", or "note this down".',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'A clear, short title (3–7 words)' },
                        content: { type: 'string', description: 'The full note content as plain text' },
                        tags: { type: 'array', items: { type: 'string' }, description: 'Optional topic tags e.g. ["ideas", "work"]' },
                    },
                    required: ['title', 'content'],
                },
            },
            {
                name: 'search',
                description: `Unified search over the user's notes. Use for any request involving listing, searching, or scoping notes by time, topic, or folder.

DATE MAPPING — always compute and pass the actual ISO date, never leave it empty:
- "recent" / "lately" / "recently" → from = today minus 7 days
- "last week" → from = today minus 7 days
- "last month" / "this month" → from = today minus 30 days
- "last 3 months" → from = today minus 90 days
- "this year" → from = Jan 1 of current year
- "yesterday" → from = yesterday, to = yesterday
- "today" → from = today, to = today
Today's date is always available from the system clock — compute dates relative to it.`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        q: { type: 'string', description: 'Full-text search across title, content, tags, and AI keywords.' },
                        from: { type: 'string', description: 'Start date ISO string e.g. "2026-01-01". Notes created on or after this date. ALWAYS compute and pass this when the user uses relative time words like "recent", "last week", "lately", etc.' },
                        to: { type: 'string', description: 'End date ISO string e.g. "2026-03-07". Notes created on or before this date.' },
                        keywords: { type: 'array', items: { type: 'string' }, description: 'Filter to notes that contain at least one of these AI-extracted keywords.' },
                        folder_id: { type: 'string', description: 'Scope results to a specific folder ID. Use "root" for unfiled notes. Get folder IDs from list_folders.' },
                        include_subfolders: { type: 'boolean', description: 'When folder_id is set, also include notes in nested subfolders. Default true.' },
                        limit: { type: 'number', description: 'Max notes to return. Default 20, max 100.' },
                        return_type: { type: 'string', enum: ['notes', 'keywords', 'both'], description: '"notes" returns note list, "keywords" returns the keyword graph for the matched set, "both" returns both. Default "both".' },
                    },
                },
            },
            {
                name: 'hybrid_search',
                description: 'Hybrid retrieval across notes using lexical + vector + recency + keyword overlap. Use for semantic-style discovery and better contextual recall.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Natural language query text.' },
                        from: { type: 'string', description: 'Optional start date ISO string e.g. "2026-01-01". Filters by last-modified date.' },
                        to: { type: 'string', description: 'Optional end date ISO string e.g. "2026-01-31". Filters by last-modified date.' },
                        folder_id: { type: 'string', description: 'Optional folder scope. Use "root" for unfiled notes.' },
                        include_subfolders: { type: 'boolean', description: 'When folder scope is provided, include nested folders (default true).' },
                        limit: { type: 'number', description: 'Max results to return. Default 10, max 50.' },
                        min_score: { type: 'number', description: 'Optional minimum threshold between 0 and 1.' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'suggest_related_notes',
                description: 'Suggest related notes based on a note ID or raw text context. Useful for "what notes are similar to this?"',
                inputSchema: {
                    type: 'object',
                    properties: {
                        note_id: { type: 'string', description: 'Source note ID (optional if text is supplied).' },
                        text: { type: 'string', description: 'Raw query text to match against notes (optional if note_id is supplied).' },
                        limit: { type: 'number', description: 'Max related notes. Default 8, max 20.' },
                    },
                },
            },
            {
                name: 'answer_with_notes',
                description: 'Grounded answer generation from retrieved notes. Returns response plus cited note IDs.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        question: { type: 'string', description: 'The user question to answer using notes context.' },
                        limit: { type: 'number', description: 'How many notes to retrieve for context. Default 6.' },
                    },
                    required: ['question'],
                },
            },
            {
                name: 'get_note',
                description: 'Read the full content of a single note by its ID.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The note ID shown in [brackets] in list/search results' },
                    },
                    required: ['id'],
                },
            },
            {
                name: 'append_to_note',
                description: 'Add new content to the end of an existing note. Use when the user says "add this to my note about X".',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The note ID to append to' },
                        content: { type: 'string', description: 'The text to add at the end' },
                    },
                    required: ['id', 'content'],
                },
            },
            {
                name: 'delete_note',
                description: 'Permanently delete a note. Always confirm with the user before calling this.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The note ID to delete' },
                    },
                    required: ['id'],
                },
            },
            {
                name: 'list_folders',
                description: 'Returns the full folder tree with note counts at each level. Call this first when the user mentions a folder by name, or before using folder_id in search.',
                inputSchema: { type: 'object', properties: {} },
            },
            // {
            //     name: 'get_keyword_graph',
            //     description: 'Returns the user\'s full keyword graph — all concepts extracted from their notes, how often each appears, and which keywords co-occur together. Use this to understand the overall shape of someone\'s thinking before answering questions about their notes.',
            //     inputSchema: { type: 'object', properties: {} },
            // },
            // {
            //     name: 'get_related_concepts',
            //     description: 'Given a keyword, returns all notes that contain it AND all related keywords (concepts that appear in the same notes). Use this for deep dives: "what does my thinking around anxiety connect to?"',
            //     inputSchema: {
            //         type: 'object',
            //         properties: {
            //             keyword: { type: 'string', description: 'The concept to explore (e.g. "anxiety", "work", "sleep")' },
            //         },
            //         required: ['keyword'],
            //     },
            // },
            {
                name: 'analyze_patterns',
                description: 'Analyzes temporal patterns in the user\'s notes: which keywords are growing vs fading, what\'s been on their mind recently, and a week-by-week keyword timeline. Use when asked "what have I been thinking about lately?" or "what patterns do you see in my notes?"',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'get_recent_notes',
                description: 'Returns the most recently created notes, newest first. Use when the user asks "show me my latest notes", "what did I write recently?", or "show my last N notes". Default is 10, user can request more.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        limit: { type: 'number', description: 'Number of recent notes to return. Default 10, max 100.' },
                    },
                },
            },
            {
                name: 'get_app_info',
                description: 'Returns a description of VoiceFlow Notes and a guide on which tool to use for each type of request. Call this if you are unsure what the app does or which tool to use.',
                inputSchema: { type: 'object', properties: {} },
            },
        ],
    }));

    /* ---------- TOOL EXECUTION ---------- */
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        try {
            switch (name) {

                case 'create_note': {
                    const { title, content, tags = [] } = args as { title: string; content: string; tags?: string[] };
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

                case 'list_folders': {
                    const folders = await getFolders(userId);
                    if (folders.length === 0) return ok('No folders yet.');

                    const renderTree = (nodes: any[], indent = 0): string =>
                        nodes.map(f => {
                            const pad = '  '.repeat(indent);
                            const sub = f.children?.length ? '\n' + renderTree(f.children, indent + 1) : '';
                            return `${pad}📁 ${f.name} [id: ${f.id}] — ${f.noteCount} note${f.noteCount !== 1 ? 's' : ''}${sub}`;
                        }).join('\n');

                    // Build note count map
                    const { searchNotes: sn } = await import('../services/notesService.js');
                    const allNotes = await sn(userId, { limit: 1000 });
                    const countMap: Record<string, number> = {};
                    for (const n of allNotes as any[]) {
                        if (n.folderId) countMap[n.folderId] = (countMap[n.folderId] || 0) + 1;
                    }

                    const tree = buildFolderTree(folders, countMap);
                    return ok(`Your folder structure:\n\n${renderTree(tree)}\n\nUse folder_id in the search tool to scope notes to a folder.`);
                }

                case 'search': {
                    const {
                        q,
                        from,
                        to,
                        keywords,
                        folder_id,
                        include_subfolders = true,
                        limit = 20,
                        return_type = 'both',
                    } = (args || {}) as {
                        q?: string;
                        from?: string;
                        to?: string;
                        keywords?: string[];
                        folder_id?: string;
                        include_subfolders?: boolean;
                        limit?: number;
                        return_type?: 'notes' | 'keywords' | 'both';
                    };

                    const notes = await searchNotes(userId, {
                        q,
                        from,
                        to,
                        keywords,
                        folderId: folder_id,
                        includeSubfolders: include_subfolders,
                        limit: Math.min(Number(limit) || 20, 100),
                    });

                    if (notes.length === 0) {
                        const scope = [q && `"${q}"`, from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(', ');
                        return ok(`No notes found${scope ? ` for ${scope}` : ''}.`);
                    }

                    const includeNotes    = return_type === 'notes'    || return_type === 'both';
                    const includeKeywords = return_type === 'keywords'  || return_type === 'both';

                    const parts: string[] = [];

                    if (includeNotes) {
                        const noteLines = notes.map((n: any) => {
                            const preview = stripHtml(n.text || '').slice(0, 150);
                            const previewText = preview ? `\n   "${preview}${preview.length === 150 ? '…' : ''}"` : '';
                            return formatNote(n) + previewText;
                        }).join('\n\n');
                        parts.push(`NOTES (${notes.length}):\n\n${noteLines}`);
                    }

                    if (includeKeywords) {
                        const { nodes, edges } = buildGraphFromNotes(notes);
                        if (nodes.length > 0) {
                            const topNodes = [...nodes].sort((a, b) => b.count - a.count).slice(0, 20);
                            const topEdges = [...edges].sort((a, b) => b.weight - a.weight).slice(0, 20);
                            const nodeLines = topNodes.map(n => `  ${n.keyword} (${n.count})`).join(', ');
                            const edgeLines = topEdges.map(e => `  ${e.source} ↔ ${e.target} (${e.weight})`).join('\n');
                            parts.push(`KEYWORD GRAPH (scoped to results):\nConcepts: ${nodeLines}\n\nAssociations:\n${edgeLines}`);
                        }
                    }

                    return ok(parts.join('\n\n---\n\n'));
                }

                case 'hybrid_search': {
                    const {
                        query,
                        from,
                        to,
                        folder_id,
                        include_subfolders = true,
                        limit = 10,
                        min_score,
                    } = (args || {}) as {
                        query?: string;
                        from?: string;
                        to?: string;
                        folder_id?: string;
                        include_subfolders?: boolean;
                        limit?: number;
                        min_score?: number;
                    };

                    if (!query?.trim()) return err('query is required');

                    const results = await hybridSearchNotes(userId, {
                        query: query.trim(),
                        from,
                        to,
                        folderId: folder_id,
                        includeSubfolders: include_subfolders,
                        limit: Math.min(Number(limit) || 10, 50),
                        minScore: typeof min_score === 'number' ? min_score : undefined,
                    });

                    if (results.length === 0) return ok('No hybrid matches found.');

                    const lines = results.map((r, idx) =>
                        `${idx + 1}. [${r.noteId}] ${r.title}\n` +
                        `   score=${r.score} (vector=${r.vectorScore}, lexical=${r.lexicalScore}, recency=${r.recencyBoost}, keyword=${r.keywordOverlap})\n` +
                        `   "${r.snippet}"`
                    ).join('\n\n');

                    return ok(`HYBRID RESULTS (${results.length}):\n\n${lines}`);
                }

                case 'suggest_related_notes': {
                    const { note_id, text, limit = 8 } = (args || {}) as {
                        note_id?: string;
                        text?: string;
                        limit?: number;
                    };

                    if (!note_id && !text?.trim()) return err('note_id or text is required');

                    const results = await suggestRelatedNotes(userId, {
                        noteId: note_id,
                        text: text?.trim(),
                        limit: Math.min(Number(limit) || 8, 20),
                    });

                    if (results.length === 0) return ok('No related notes found.');
                    const lines = results.map((r, idx) =>
                        `${idx + 1}. [${r.noteId}] ${r.title} (score=${r.score})\n   "${r.snippet}"`
                    ).join('\n\n');
                    return ok(`RELATED NOTES (${results.length}):\n\n${lines}`);
                }

                case 'answer_with_notes': {
                    const { question, limit = 6 } = (args || {}) as { question?: string; limit?: number };
                    if (!question?.trim()) return err('question is required');

                    const matches = await hybridSearchNotes(userId, {
                        query: question.trim(),
                        limit: Math.min(Number(limit) || 6, 12),
                        minScore: 0.1,
                    });

                    if (matches.length === 0) return ok('No relevant notes found.');

                    const lines = matches.map((m, idx) =>
                        `${idx + 1}. [${m.noteId}] ${m.title}\n` +
                        `   score=${m.score} (vector=${m.vectorScore}, lexical=${m.lexicalScore}, recency=${m.recencyBoost}, keyword=${m.keywordOverlap})\n` +
                        `   "${m.snippet}"`
                    ).join('\n\n');

                    return ok(`RELEVANT NOTES FOR: "${question.trim()}"\n\n${lines}`);
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

                case 'get_keyword_graph': {
                    const { nodes, edges } = await buildKeywordGraph(userId);
                    if (nodes.length === 0) return ok('No keywords found yet. Add some notes with AI analysis first.');

                    const topNodes = [...nodes]
                        .sort((a, b) => b.count - a.count)
                        .slice(0, 30);

                    const topEdges = [...edges]
                        .sort((a, b) => b.weight - a.weight)
                        .slice(0, 40);

                    const nodeLines = topNodes.map(n =>
                        `  ${n.keyword} (${n.count} notes, first: ${n.firstSeen.slice(0, 10)}, last: ${n.lastSeen.slice(0, 10)})`
                    ).join('\n');

                    const edgeLines = topEdges.map(e =>
                        `  ${e.source} ↔ ${e.target} (co-occur in ${e.weight} notes)`
                    ).join('\n');

                    return ok(
                        `Keyword Graph — ${nodes.length} concepts across all notes\n\n` +
                        `TOP CONCEPTS:\n${nodeLines}\n\n` +
                        `STRONGEST ASSOCIATIONS:\n${edgeLines}`
                    );
                }

                case 'get_related_concepts': {
                    const { keyword } = args as { keyword: string };
                    if (!keyword?.trim()) return err('keyword is required');

                    const result = await getRelatedConcepts(userId, keyword.trim());

                    if (result.directNotes.length === 0) {
                        return ok(`No notes found with keyword "${keyword}".`);
                    }

                    const directLines = result.directNotes
                        .map(n => `  [${n.id}] ${n.title} — ${n.date.slice(0, 10)}`)
                        .join('\n');

                    const relatedLines = result.relatedKeywords.length > 0
                        ? result.relatedKeywords.map(r =>
                            `  ${r.keyword} (shared in ${r.sharedNotes} notes)`
                          ).join('\n')
                        : '  None';

                    return ok(
                        `Concept: "${result.keyword}" — appears in ${result.directNotes.length} notes\n\n` +
                        `NOTES:\n${directLines}\n\n` +
                        `RELATED CONCEPTS:\n${relatedLines}`
                    );
                }

                case 'analyze_patterns': {
                    const { topKeywords, recentClusters, timeline } = await analyzePatterns(userId);

                    if (topKeywords.length === 0) return ok('Not enough notes yet to detect patterns.');

                    const trendIcon = (t: string) => t === 'growing' ? '↑' : t === 'fading' ? '↓' : '→';

                    const topLines = topKeywords.map(k =>
                        `  ${trendIcon(k.trend)} ${k.keyword} — ${k.count} total (${k.recent} recent, ${k.prior} prior)`
                    ).join('\n');

                    const recentLines = recentClusters.map(k =>
                        `  ${k.keyword}: ${k.recentCount} notes in last 30 days`
                    ).join('\n');

                    const timelineLines = timeline.map(w =>
                        `  Week of ${w.period}: ${w.keywords.join(', ')}`
                    ).join('\n');

                    return ok(
                        `Pattern Analysis\n\n` +
                        `TOP CONCEPTS (↑ growing · → stable · ↓ fading):\n${topLines}\n\n` +
                        `MOST ACTIVE LAST 30 DAYS:\n${recentLines}\n\n` +
                        `WEEKLY TIMELINE:\n${timelineLines}`
                    );
                }

                case 'get_recent_notes': {
                    const { limit = 10 } = (args || {}) as { limit?: number };
                    const count = Math.min(Math.max(Number(limit) || 10, 1), 100);

                    // Fetch more than needed so we can sort in-memory (avoids composite index requirement)
                    const snap = await db.collection('notes')
                        .where('userId', '==', userId)
                        .limit(Math.min(count * 5, 500))
                        .get();

                    if (snap.empty) return ok('No notes found.');

                    const sorted = snap.docs
                        .slice()
                        .sort((a, b) => {
                            const aTime = a.data().createdAt?.toMillis?.() ?? 0;
                            const bTime = b.data().createdAt?.toMillis?.() ?? 0;
                            return bTime - aTime;
                        })
                        .slice(0, count);

                    const lines = sorted.map(doc => {
                        const data = doc.data() as any;
                        const note = {
                            id: doc.id, ...data,
                            updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt,
                        };
                        const preview = stripHtml(data.text || '').slice(0, 120);
                        const previewText = preview ? `\n   "${preview}${preview.length === 120 ? '…' : ''}"` : '';
                        return formatNote(note) + previewText;
                    }).join('\n\n');

                    return ok(`RECENT NOTES (${sorted.length}):\n\n${lines}`);
                }

                case 'get_app_info': {
                    return ok(
`VoiceFlow Notes — AI-powered voice-first note-taking app
==========================================================
Users capture notes by voice or text. Each note is automatically enriched with
AI-extracted keywords (aiKeywords), which power a keyword co-occurrence graph
used for semantic search and insight. Notes can live in nested folders.

TOOL GUIDE
----------
create_note
  → User says "save this", "note that down", "create a note about X"
  → Pass title + content (plain text). Optionally pass tags.

search
  → ANY request to list, find, or filter notes — by text, date, keyword, or folder
  → IMPORTANT: always compute real ISO dates from relative time words:
      "recent" / "lately"  → from = 7 days ago
      "last week"          → from = 7 days ago
      "last month"         → from = 30 days ago
      "last 3 months"      → from = 90 days ago
      "this year"          → from = Jan 1 of current year
      "today"              → from = to = today
  → return_type="notes" for a plain list, "keywords" for concept graph, "both" for both
  → Use folder_id to scope to a folder (get IDs from list_folders first)

get_note
  → User asks to read or quote the full content of a specific note
  → Requires the note ID (shown in [brackets] in search results)

append_to_note
  → User says "add this to my note about X" or "update that note with..."
  → Search first to find the note ID, then append

delete_note
  → Always confirm with the user before deleting
  → Search first to find the note ID

list_folders
  → Call this before using folder_id in search, or when user mentions a folder by name
  → Returns the full nested folder tree with note counts

get_keyword_graph
  → User wants to understand the overall shape of their thinking / all their topics
  → Returns all AI-extracted concepts and their co-occurrence relationships

get_related_concepts
  → User wants to deep-dive on one topic: "what connects to my anxiety notes?"
  → Returns all notes with that keyword + every related concept

analyze_patterns
  → User asks "what have I been thinking about lately?", "show me trends", "what's growing?"
  → Returns top concepts with growing/stable/fading trend + weekly timeline

get_recent_notes
  → User asks "show my latest notes", "what did I write recently?", "show my last N notes"
  → Default 10 notes, user can specify more (max 100)
  → Sorted newest-first by creation date

get_app_info
  → This tool — call when unsure which tool to use or what the app does

RECOMMENDED STARTING FLOW
--------------------------
1. If the request is time-scoped → search with from/to computed from today's date
2. If the request names a folder → list_folders first, then search with folder_id
3. If the request is about patterns or trends → analyze_patterns
4. If the request is about one concept → get_related_concepts
5. For general "what are my notes about" → get_keyword_graph`
                    );
                }

                default:
                    return err(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            console.error(`[MCP] Error in tool "${name}":`, error);
            return err(error.message || 'Something went wrong');
        }
    });

    return server;
}
