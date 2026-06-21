import { db } from '../config/firebase';
import { searchNotes, getNotes } from './notesService';
import { generateCompletion } from './aiService';
import { embedDocuments, embedQuery } from './embeddingService';
import { embeddingConfig, chunkingConfig, retrievalConfig } from '../config/appConfig';

const NOTE_CHUNKS_COLLECTION = 'noteChunks';

export interface HybridSearchParams {
    query: string;
    from?: string;
    to?: string;
    folderId?: string;
    includeSubfolders?: boolean;
    limit?: number;
    minScore?: number;
}

export interface HybridSearchResult {
    noteId: string;
    title: string;
    snippet: string;
    score: number;
    vectorScore: number;
    lexicalScore: number;
    recencyBoost: number;
    keywordOverlap: number;
    updatedAt: string;
}

export interface RagResult {
    answer: string;
    sources: HybridSearchResult[];
    query: string;
}

interface NoteChunkDoc {
    id: string;
    noteId: string;
    userId: string;
    chunkText: string;
    chunkIndex: number;
    tokenCount: number;
    embedding: number[];
    updatedAt: Date;
    createdAt: Date;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

const stripHtml = (html: string) =>
    (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
    'from','is','it','its','this','that','are','was','were','be','been','have',
    'has','had','do','does','did','will','would','could','should','may','might',
    'i','my','me','we','our','you','your','he','she','they','their','what',
    'which','who','how','when','where','why','not','no','if','as','so','then',
    'than','into','about','up','out','get','got','just','also','can','all',
]);

const tokenize = (text: string): string[] =>
    (text.toLowerCase().match(/[a-z0-9]+/g) || [])
        .filter(t => t.length > 1 && !STOP_WORDS.has(t));

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ─── Cosine similarity ────────────────────────────────────────────────────────

const cosineSimilarity = (a: number[], b: number[]): number => {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return clamp01(dot);
};

// ─── BM25 lexical scoring ─────────────────────────────────────────────────────

const BM25_K1 = 1.5;  // term saturation — higher = less saturation
const BM25_B  = 0.75; // length normalisation — 1.0 = full normalisation

interface Bm25Index {
    idf: Map<string, number>;   // term → IDF weight
    avgdl: number;              // average document length in tokens
}

/**
 * Build a BM25 index from a corpus of documents (called once per search).
 * IDF = log((N + 1) / (df + 0.5))  — always positive, no smoothing needed.
 */
const buildBm25Index = (docs: string[]): Bm25Index => {
    const df = new Map<string, number>(); // document frequency per term
    const lengths: number[] = [];

    for (const doc of docs) {
        const tokens = new Set(tokenize(doc)); // unique terms per doc
        lengths.push(tokens.size);
        for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
    }

    const N = docs.length;
    const avgdl = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1;
    const idf = new Map<string, number>();
    for (const [term, freq] of df) {
        idf.set(term, Math.log((N + 1) / (freq + 0.5)));
    }
    return { idf, avgdl };
};

/**
 * Score a single document against the query using BM25.
 * Returns a value roughly in [0, ~3] — caller should clamp.
 */
const bm25Score = (queryTokens: string[], docText: string, index: Bm25Index): number => {
    const docTokens = tokenize(docText);
    if (docTokens.length === 0 || queryTokens.length === 0) return 0;

    // Term frequency map for this document
    const tf = new Map<string, number>();
    for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    const dl = docTokens.length;
    let score = 0;

    for (const term of queryTokens) {
        const termTf = tf.get(term) ?? 0;
        if (termTf === 0) continue;
        const termIdf = index.idf.get(term) ?? Math.log((index.avgdl + 1) / 0.5); // unseen term fallback
        const tfNorm = (termTf * (BM25_K1 + 1)) /
            (termTf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / index.avgdl)));
        score += termIdf * tfNorm;
    }

    // Normalise to [0, 1]: divide by max possible score (all query terms perfectly match)
    const maxScore = queryTokens.reduce((acc, term) => {
        const idf = index.idf.get(term) ?? Math.log((index.avgdl + 1) / 0.5);
        return acc + idf * (BM25_K1 + 1);
    }, 0);

    return maxScore > 0 ? clamp01(score / maxScore) : 0;
};

// ─── Recency boost ────────────────────────────────────────────────────────────

const recencyScore = (updatedAtIso: string): number => {
    const updatedAt = new Date(updatedAtIso).getTime();
    if (!Number.isFinite(updatedAt)) return 0.2;
    const ageDays = Math.max(0, (Date.now() - updatedAt) / (1000 * 60 * 60 * 24));
    return clamp01(Math.exp(-ageDays / 30));
};

const asIso = (value: any): string => {
    if (!value) return new Date(0).toISOString();
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return new Date(0).toISOString();
};

// ─── Chunking ─────────────────────────────────────────────────────────────────

const buildChunks = (text: string): string[] => {
    const normalized = stripHtml(text);
    if (!normalized) return [];

    const paragraphLike = normalized.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const source = paragraphLike.length > 0 ? paragraphLike : [normalized];
    const maxWords = chunkingConfig.maxWordsPerChunk;
    const chunks: string[] = [];

    for (const part of source) {
        const words = part.split(/\s+/).filter(Boolean);
        if (words.length <= maxWords) { chunks.push(part); continue; }
        for (let i = 0; i < words.length; i += maxWords) {
            chunks.push(words.slice(i, i + maxWords).join(' '));
        }
    }
    return chunks.slice(0, chunkingConfig.maxChunksPerNote);
};

// ─── Content fingerprint ──────────────────────────────────────────────────────

/** FNV-1a hash of the full stripped text — used to skip reindex when content unchanged */
const textHash = (text: string): string => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h).toString(36);
};

// ─── Indexing ─────────────────────────────────────────────────────────────────

export const reindexNoteEmbeddings = async (userId: string, noteId: string) => {
    const noteRef = db.collection('notes').doc(noteId);
    const noteSnap = await noteRef.get();
    if (!noteSnap.exists) throw new Error('Note not found');

    const note = noteSnap.data() as any;
    if (note.userId !== userId) throw new Error('Access denied');

    const text = `${note.title || ''}\n${stripHtml(note.text || '')}`.trim();

    // Skip entirely if content hasn't changed since the last index
    const currentHash = textHash(text);
    if (note.indexedTextHash && note.indexedTextHash === currentHash) {
        return {
            noteId,
            skipped: true,
            reason: 'content_unchanged',
            embeddingVersion: note.embeddingVersion,
        };
    }

    const chunkTexts = buildChunks(text);

    // Delete existing chunks
    const existing = await db.collection(NOTE_CHUNKS_COLLECTION)
        .where('userId', '==', userId)
        .where('noteId', '==', noteId)
        .get();
    if (!existing.empty) {
        const deleteBatch = db.batch();
        existing.docs.forEach(doc => deleteBatch.delete(doc.ref));
        await deleteBatch.commit();
    }

    const now = new Date();
    if (chunkTexts.length > 0) {
        // Embed all chunks in one batched API call
        const embeddings = await embedDocuments(chunkTexts);

        const writeBatch = db.batch();
        chunkTexts.forEach((chunkText, idx) => {
            const ref = db.collection(NOTE_CHUNKS_COLLECTION).doc();
            writeBatch.set(ref, {
                userId,
                noteId,
                chunkText,
                chunkIndex: idx,
                tokenCount: tokenize(chunkText).length,
                embedding: embeddings[idx] ?? [],
                createdAt: now,
                updatedAt: now,
            });
        });
        await writeBatch.commit();
    }

    await noteRef.update({
        embeddingVersion: embeddingConfig.version,
        embeddingStatus: chunkTexts.length > 0 ? 'ready' : 'empty',
        embeddingUpdatedAt: now,
        embeddingChunkCount: chunkTexts.length,
        indexedTextHash: currentHash,
        updatedAt: now,
    });

    return {
        noteId,
        skipped: false,
        chunksIndexed: chunkTexts.length,
        embeddingVersion: embeddingConfig.version,
    };
};

export const deleteNoteEmbeddings = async (userId: string, noteId: string) => {
    const existing = await db.collection(NOTE_CHUNKS_COLLECTION)
        .where('userId', '==', userId)
        .where('noteId', '==', noteId)
        .get();
    if (existing.empty) return { deletedChunks: 0 };
    const batch = db.batch();
    existing.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    return { deletedChunks: existing.size };
};

// ─── Core retrieval ───────────────────────────────────────────────────────────

export const hybridSearchNotes = async (
    userId: string,
    params: HybridSearchParams
): Promise<HybridSearchResult[]> => {
    const queryText = (params.query || '').trim();
    if (!queryText) return [];

    // Fetch all notes in scope — NO keyword pre-filter, let scoring decide relevance
    // Date filter is applied in-memory on updatedAt (not createdAt) so hybrid search
    // scopes by when notes were last modified, consistent with the recency boost.
    let candidateNotes = await searchNotes(userId, {
        folderId: params.folderId,
        includeSubfolders: params.includeSubfolders !== false,
        limit: 500,
    });
    if (candidateNotes.length === 0) return [];

    if (params.from || params.to) {
        const fromMs = params.from ? new Date(params.from).getTime() : 0;
        const toMs = params.to
            ? (/^\d{4}-\d{2}-\d{2}$/.test(params.to)
                ? new Date(params.to + 'T23:59:59.999Z')
                : new Date(params.to)
              ).getTime()
            : Infinity;
        candidateNotes = candidateNotes.filter(note => {
            const ms = new Date(asIso(note.updatedAt)).getTime();
            return ms >= fromMs && ms <= toMs;
        });
        if (candidateNotes.length === 0) return [];
    }

    const candidateMap = new Map<string, any>();
    candidateNotes.forEach(note => candidateMap.set(note.id, note));

    // Load indexed chunks for these notes (single Firestore read)
    const chunkSnapshot = await db.collection(NOTE_CHUNKS_COLLECTION)
        .where('userId', '==', userId)
        .get();

    const chunks: NoteChunkDoc[] = chunkSnapshot.docs
        .map(doc => {
            const data = doc.data() as any;
            return {
                id: doc.id,
                noteId: data.noteId,
                userId: data.userId,
                chunkText: data.chunkText || '',
                chunkIndex: Number(data.chunkIndex || 0),
                tokenCount: Number(data.tokenCount || 0),
                embedding: Array.isArray(data.embedding) ? data.embedding : [],
                createdAt: data.createdAt?.toDate?.() || new Date(0),
                updatedAt: data.updatedAt?.toDate?.() || new Date(0),
            };
        })
        .filter(c => candidateMap.has(c.noteId));

    // Build BM25 index from all corpus texts (chunks + note-level fallbacks)
    const corpusTexts: string[] = [
        ...chunks.map(c => c.chunkText),
        ...candidateNotes.map(n => `${n.title || ''} ${stripHtml(n.text || '')}`),
    ];
    const bm25Index = buildBm25Index(corpusTexts);

    // Embed query once — search_query task type for asymmetric retrieval
    const queryEmbedding = await embedQuery(queryText);
    const qTokens = tokenize(queryText);          // array for BM25
    const qTokenSet = new Set(qTokens);           // set for keyword-overlap check
    const grouped = new Map<string, HybridSearchResult>();

    for (const note of candidateNotes) {
        const noteChunks = chunks.filter(c => c.noteId === note.id);
        const noteFullText = `${note.title || ''} ${stripHtml(note.text || '')}`;

        // Note-level BM25 as baseline (always available, no API call)
        let bestLexical = bm25Score(qTokens, noteFullText, bm25Index);
        let bestSnippet = stripHtml(note.text || '').slice(0, 280);

        // Chunk-level scoring — pick whichever chunk scores best
        let bestVector = 0;
        for (const chunk of noteChunks) {
            if (chunk.embedding.length === 0) continue;
            const v = cosineSimilarity(queryEmbedding, chunk.embedding);
            const l = bm25Score(qTokens, chunk.chunkText, bm25Index);
            if (v + l > bestVector + bestLexical) {
                bestVector = v;
                bestLexical = l;
                bestSnippet = chunk.chunkText.slice(0, 320);
            }
        }

        const keywords: string[] = Array.isArray(note.aiKeywords) ? note.aiKeywords : [];
        const keywordHitCount = keywords.reduce(
            (acc, kw) => acc + (qTokenSet.has(String(kw).toLowerCase()) ? 1 : 0), 0
        );
        const keywordOverlap = keywords.length > 0 ? keywordHitCount / keywords.length : 0;
        const recencyBoost = recencyScore(asIso(note.updatedAt));

        const score =
            0.50 * bestVector +
            0.30 * bestLexical +
            0.10 * recencyBoost +
            0.10 * keywordOverlap;

        if (score < (params.minScore ?? retrievalConfig.defaultMinScore)) continue;

        grouped.set(note.id, {
            noteId: note.id,
            title: note.title || 'Untitled',
            snippet: bestSnippet,
            score: Number(score.toFixed(4)),
            vectorScore: Number(bestVector.toFixed(4)),
            lexicalScore: Number(bestLexical.toFixed(4)),
            recencyBoost: Number(recencyBoost.toFixed(4)),
            keywordOverlap: Number(keywordOverlap.toFixed(4)),
            updatedAt: asIso(note.updatedAt),
        });
    }

    const sorted = [...grouped.values()].sort((a, b) => b.score - a.score);
    return sorted.slice(0, Math.min(params.limit || retrievalConfig.defaultLimit, 50));
};

// ─── RAG: retrieval + LLM synthesis ──────────────────────────────────────────

export const ragQuery = async (
    userId: string,
    params: HybridSearchParams & { provider?: 'groq' | 'openrouter' }
): Promise<RagResult> => {
    const queryText = (params.query || '').trim();
    if (!queryText) throw new Error('query is required');

    const sources = await hybridSearchNotes(userId, {
        ...params,
        limit: Math.min(params.limit || retrievalConfig.ragDefaultSources, retrievalConfig.ragMaxSources),
        minScore: params.minScore ?? 0.03,
    });

    if (sources.length === 0) {
        return {
            answer: "I couldn't find any relevant notes for your query. Try indexing your notes first, or rephrase the question.",
            sources: [],
            query: queryText,
        };
    }

    const contextBlock = sources
        .map((s, i) => `[${i + 1}] Note: "${s.title}"\n${s.snippet}`)
        .join('\n\n---\n\n');

    const systemPrompt =
        'You are a personal knowledge assistant. Answer using ONLY the context from the user\'s notes provided. ' +
        'Be concise and direct. If the context does not fully answer the question, say so clearly. ' +
        'Do not refer to "context" or "notes" — speak naturally as if recalling the user\'s own work.';

    const userPrompt = `Context from notes:\n\n${contextBlock}\n\n---\n\nQuestion: ${queryText}`;

    let answer: string;
    try {
        answer = await generateCompletion(userPrompt, params.provider || 'groq', systemPrompt);
    } catch (e: any) {
        answer = 'AI synthesis failed. Here are the retrieved chunks below.';
        console.error('RAG LLM error:', e);
    }

    return { answer: answer.trim(), sources, query: queryText };
};

// ─── Suggest related ─────────────────────────────────────────────────────────

export const suggestRelatedNotes = async (
    userId: string,
    input: { noteId?: string; text?: string; limit?: number }
) => {
    let query = (input.text || '').trim();
    if (!query && input.noteId) {
        const snap = await db.collection('notes').doc(input.noteId).get();
        if (!snap.exists) throw new Error('Source note not found');
        const note = snap.data() as any;
        if (note.userId !== userId) throw new Error('Access denied');
        query = `${note.title || ''} ${stripHtml(note.text || '').slice(0, 800)}`.trim();
    }
    if (!query) return [];

    const hits = await hybridSearchNotes(userId, {
        query,
        limit: input.limit || 8,
        minScore: retrievalConfig.defaultMinScore,
    });
    return input.noteId ? hits.filter(h => h.noteId !== input.noteId) : hits;
};

// ─── Batch reindex ────────────────────────────────────────────────────────────

export const reindexAllNotesEmbeddings = async (
    userId: string,
    opts?: { limit?: number; startAfterUpdatedAt?: string; offset?: number }
) => {
    const notes = await getNotes(userId);
    const startAfter = opts?.startAfterUpdatedAt
        ? new Date(opts.startAfterUpdatedAt).getTime()
        : null;
    const filtered = notes.filter(
        (n: any) => !startAfter || new Date(n.updatedAt).getTime() > startAfter
    );
    const offset = Math.max(0, opts?.offset || 0);
    const limit = Math.min(Math.max(1, opts?.limit || filtered.length), 1000);
    const eligible = filtered.slice(offset, offset + limit);

    let indexed = 0;
    let failed = 0;
    const failures: Array<{ noteId: string; reason: string }> = [];

    for (const note of eligible) {
        try {
            await reindexNoteEmbeddings(userId, note.id);
            indexed++;
        } catch (error: any) {
            failed++;
            failures.push({ noteId: note.id, reason: error?.message || 'unknown_error' });
        }
    }

    return {
        totalNotes: notes.length,
        totalEligible: filtered.length,
        offset,
        hasMore: offset + eligible.length < filtered.length,
        nextOffset: offset + eligible.length,
        attempted: eligible.length,
        indexed,
        failed,
        failures: failures.slice(0, 20),
    };
};
