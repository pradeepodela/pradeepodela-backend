import { Request, Response } from 'express';
import { generateCompletion, transcribeAudio } from '../services/aiService';
import { AuthRequest } from '../middleware/auth';
import {
    hybridSearchNotes,
    ragQuery,
    reindexAllNotesEmbeddings,
    reindexNoteEmbeddings,
    suggestRelatedNotes
} from '../services/retrievalService';

export const generate = async (req: Request, res: Response) => {
    try {
        const { prompt, provider, systemMessage } = req.body;

        if (!prompt) {
            return res.status(400).json({ message: 'Prompt is required' });
        }

        const result = await generateCompletion(prompt, provider, systemMessage);

        res.json({ result });
    } catch (error) {
        console.error('AI Controller Error:', error);
        res.status(500).json({ message: 'Internal server error processing AI request' });
    }
};

export const transcribe = async (req: Request, res: Response) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No audio file provided' });
        }

        console.log('[DEBUG] Transcribing file buffer, size:', req.file.size);

        const result = await transcribeAudio(req.file.buffer, req.file.originalname, req.body.provider || 'groq');
        console.log('[DEBUG] Transcription success');

        res.json({ text: result });
    } catch (error) {
        console.error('Transcription Error:', error);
        res.status(500).json({ message: 'Internal server error processing transcription' });
    }
};

export const reindexNote = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { noteId } = req.body as { noteId?: string };
        if (!noteId?.trim()) {
            return res.status(400).json({ message: 'noteId is required' });
        }

        const result = await reindexNoteEmbeddings(userId, noteId.trim());
        res.json(result);
    } catch (error: any) {
        console.error('Reindex Error:', error);
        res.status(500).json({ message: error?.message || 'Failed to reindex note embeddings' });
    }
};

export const hybridSearch = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { query, from, to, folderId, includeSubfolders, limit, minScore } = req.body as {
            query?: string;
            from?: string;
            to?: string;
            folderId?: string;
            includeSubfolders?: boolean;
            limit?: number;
            minScore?: number;
        };

        if (!query?.trim()) {
            return res.status(400).json({ message: 'query is required' });
        }

        const results = await hybridSearchNotes(userId, {
            query: query.trim(),
            from,
            to,
            folderId,
            includeSubfolders,
            limit,
            minScore,
        });

        res.json({ query, count: results.length, results });
    } catch (error: any) {
        console.error('Hybrid Search Error:', error);
        res.status(500).json({ message: error?.message || 'Failed to run hybrid search' });
    }
};

export const ragSearch = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { query, from, to, folderId, includeSubfolders, limit, minScore, provider } = req.body as {
            query?: string;
            from?: string;
            to?: string;
            folderId?: string;
            includeSubfolders?: boolean;
            limit?: number;
            minScore?: number;
            provider?: 'groq' | 'openrouter';
        };

        if (!query?.trim()) {
            return res.status(400).json({ message: 'query is required' });
        }

        const result = await ragQuery(userId, {
            query: query.trim(),
            from,
            to,
            folderId,
            includeSubfolders,
            limit,
            minScore,
            provider,
        });

        res.json(result);
    } catch (error: any) {
        console.error('RAG Search Error:', error);
        res.status(500).json({ message: error?.message || 'Failed to run RAG query' });
    }
};

export const suggestRelated = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { noteId, text, limit } = req.body as {
            noteId?: string;
            text?: string;
            limit?: number;
        };

        if (!noteId && !text) {
            return res.status(400).json({ message: 'noteId or text is required' });
        }

        const results = await suggestRelatedNotes(userId, { noteId, text, limit });
        res.json({ count: results.length, results });
    } catch (error: any) {
        console.error('Suggest Related Error:', error);
        res.status(500).json({ message: error?.message || 'Failed to suggest related notes' });
    }
};

export const reindexAllNotes = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { limit, startAfterUpdatedAt, offset } = req.body as {
            limit?: number;
            startAfterUpdatedAt?: string;
            offset?: number;
        };

        const result = await reindexAllNotesEmbeddings(userId, {
            limit: typeof limit === 'number' ? limit : undefined,
            startAfterUpdatedAt: startAfterUpdatedAt?.trim() || undefined,
            offset: typeof offset === 'number' ? offset : undefined,
        });

        res.json(result);
    } catch (error: any) {
        console.error('Reindex All Error:', error);
        res.status(500).json({ message: error?.message || 'Failed to reindex all notes' });
    }
};
