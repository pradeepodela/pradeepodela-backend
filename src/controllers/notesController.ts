import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import * as noteService from '../services/notesService';
import { buildGraphFromNotes } from '../services/graphService';
import { deleteNoteEmbeddings, reindexNoteEmbeddings } from '../services/retrievalService';

export const createNote = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const note = await noteService.createNote(userId, req.body);
        void reindexNoteEmbeddings(userId, note.id).catch((err) => {
            console.error('Failed to index new note embeddings:', err);
        });
        res.status(201).json(note);
    } catch (error) {
        console.error('Error creating note:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const getNotes = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const notes = await noteService.getNotes(userId);
        res.json(notes);
    } catch (error) {
        console.error('Error fetching notes:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const updateNote = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { id } = req.params;
        const note = await noteService.updateNote(userId, id as string, req.body);
        // Reindexing is NOT triggered here — the frontend fires it after user inactivity.
        // The backend will skip via content-hash check if nothing actually changed.
        res.json(note);
    } catch (error: any) {
        // 5 = NOT_FOUND, 9 = FAILED_PRECONDITION (update() on a doc that doesn't exist)
        if (error?.code === 5 || error?.code === 9) {
            return res.status(404).json({ message: 'Note not found' });
        }
        console.error('Error updating note:', error?.code, error?.message, error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const deleteNote = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { id } = req.params;
        await deleteNoteEmbeddings(userId, id as string);
        await noteService.deleteNote(userId, id as string);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting note:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const publishNote = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const id = req.params.id as string;
        const { title } = req.body;
        const result = await noteService.publishNote(userId, id, title || '');
        res.json(result);
    } catch (error) {
        console.error('Error publishing note:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const unpublishNote = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const id = req.params.id as string;
        await noteService.unpublishNote(userId, id);
        res.status(204).send();
    } catch (error) {
        console.error('Error unpublishing note:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

import { Request } from 'express';

export const listPublishedNotes = async (req: Request, res: Response) => {
    try {
        const folderId = req.query.folderId as string | undefined;
        const notes = await noteService.listPublishedNotes(folderId);
        res.json(notes);
    } catch (error) {
        console.error('Error listing published notes:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const getPublishedNote = async (req: Request, res: Response) => {
    try {
        const slug = req.params.slug as string;
        const note = await noteService.getPublishedNote(slug);
        if (!note) return res.status(404).json({ message: 'Note not found or not published' });
        res.json(note);
    } catch (error) {
        console.error('Error fetching published note:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * GET /api/notes/search
 *
 * Query params (all optional):
 *   q        — full-text search (title, content, tags, aiKeywords)
 *   from     — ISO date, e.g. 2026-01-01  (createdAt >=)
 *   to       — ISO date, e.g. 2026-03-07  (createdAt <=)
 *   keywords — comma-separated aiKeywords to match, e.g. anxiety,work
 *   limit    — max notes to return (default 50)
 *   return   — "notes" | "keywords" | "both" (default "both")
 */
export const searchNotes = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const {
            q,
            from,
            to,
            keywords,
            folder_id,
            include_subfolders,
            limit,
            return: returnType = 'both',
        } = req.query as Record<string, string>;

        const filters: noteService.SearchFilters = {
            q: q || undefined,
            from: from || undefined,
            to: to || undefined,
            keywords: keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : undefined,
            folderId: folder_id || undefined,
            includeSubfolders: include_subfolders !== 'false',
            limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
        };

        const notes = await noteService.searchNotes(userId, filters);

        const includeNotes    = returnType === 'notes' || returnType === 'both';
        const includeKeywords = returnType === 'keywords' || returnType === 'both';

        const graph = includeKeywords ? buildGraphFromNotes(notes) : null;

        res.json({
            meta: {
                noteCount: notes.length,
                uniqueKeywords: graph?.nodes.length ?? 0,
                filters: { q, from, to, keywords, folder_id, include_subfolders, limit, returnType },
            },
            notes: includeNotes ? notes : undefined,
            keywords: includeKeywords ? {
                nodes: graph!.nodes.map(n => ({
                    keyword: n.keyword,
                    count: n.count,
                    firstSeen: n.firstSeen,
                    lastSeen: n.lastSeen,
                })),
                edges: graph!.edges
                    .sort((a, b) => b.weight - a.weight)
                    .slice(0, 100),
            } : undefined,
        });
    } catch (error) {
        console.error('Error searching notes:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
