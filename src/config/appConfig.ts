import dotenv from 'dotenv';
dotenv.config();

// ─── Embedding ────────────────────────────────────────────────────────────────

export type EmbeddingProvider = 'nomic' | 'hash';

export const embeddingConfig = {
    /** Which embedding backend to use */
    provider: (process.env.EMBEDDING_PROVIDER as EmbeddingProvider) || 'nomic',

    nomic: {
        // Free key from https://atlas.nomic.ai → Settings → API Keys  (format: nk-...)
        apiKey: process.env.NOMIC_API_KEY || '',
        baseUrl: 'https://api-atlas.nomic.ai/v1',
        model: process.env.NOMIC_MODEL || 'nomic-embed-text-v1.5',
        /** Dimensions produced by nomic-embed-text-v1.5 */
        dimensions: 768,
        /** task_type sent to Nomic Atlas API */
        taskTypeDoc:   'search_document' as const,
        taskTypeQuery: 'search_query' as const,
        /** Max texts per single API call (Nomic Atlas limit) */
        batchSize: 96,
    },

    hash: {
        /** Legacy fallback — FNV-1a bag-of-words, not semantic */
        dimensions: 256,
    },

    /** Version string stored on indexed notes — bump when switching models */
    version: 'nomic-v1',
} as const;

// ─── Retrieval ────────────────────────────────────────────────────────────────

export const retrievalConfig = {
    defaultLimit: 10,
    defaultMinScore: 0.05,
    ragDefaultSources: 5,
    ragMaxSources: 8,
    /** Minimum ms between re-index calls for the same note (auto-reindex throttle) */
    reindexThrottleMs: 2 * 60 * 1000, // 2 minutes
} as const;

// ─── Chunking ─────────────────────────────────────────────────────────────────

export const chunkingConfig = {
    maxWordsPerChunk: 120,
    maxChunksPerNote: 64,
} as const;

// ─── AI / LLM ─────────────────────────────────────────────────────────────────

export const aiConfig = {
    defaultProvider: 'groq' as 'groq' | 'openrouter',
    groq: {
        apiKey: process.env.GROQ_API_KEY || '',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
    },
    openRouter: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-3.5-turbo',
    },
} as const;
