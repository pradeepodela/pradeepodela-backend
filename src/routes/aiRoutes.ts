import { Router, Request, Response, NextFunction } from 'express';
import { generate, transcribe, reindexNote, hybridSearch, ragSearch, suggestRelated, reindexAllNotes } from '../controllers/aiController';
import { verifyToken } from '../middleware/auth';
import multer from 'multer';
import { Readable } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Busboy = require('busboy');

const multerMemory = multer({ storage: multer.memoryStorage() });

// Firebase Functions pre-buffers the request body into req.rawBody, which means
// the readable stream is already consumed when multer tries to read it.
// This middleware checks for rawBody (Firebase env) and falls back to multer (local dev).
const parseAudioUpload = (req: Request, res: Response, next: NextFunction) => {
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (!rawBody) {
        // Local dev: stream is intact, use multer normally
        return multerMemory.single('file')(req, res, next);
    }

    // Firebase Functions: reconstruct multipart parse from rawBody buffer
    try {
        const bb = Busboy({ headers: req.headers });
        const fields: Record<string, string> = {};

        bb.on('file', (fieldname: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
            const chunks: Buffer[] = [];
            fileStream.on('data', (chunk: Buffer) => chunks.push(chunk));
            fileStream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                (req as any).file = {
                    fieldname,
                    originalname: info.filename,
                    mimetype: info.mimeType,
                    buffer,
                    size: buffer.length,
                };
            });
        });

        bb.on('field', (name: string, value: string) => {
            fields[name] = value;
        });

        bb.on('finish', () => {
            req.body = { ...req.body, ...fields };
            next();
        });

        bb.on('error', (err: Error) => next(err));

        const readable = new Readable();
        readable.push(rawBody);
        readable.push(null);
        readable.pipe(bb);
    } catch (err) {
        next(err);
    }
};

const router = Router();

router.post('/generate', verifyToken, generate);
router.post('/transcribe', verifyToken, parseAudioUpload, transcribe);
router.post('/embeddings/reindex-note', verifyToken, reindexNote);
router.post('/embeddings/reindex-all', verifyToken, reindexAllNotes);
router.post('/retrieval/search', verifyToken, hybridSearch);
router.post('/retrieval/rag', verifyToken, ragSearch);
router.post('/retrieval/suggest', verifyToken, suggestRelated);

export default router;
