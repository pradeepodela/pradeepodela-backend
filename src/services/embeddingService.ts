import { embeddingConfig } from '../config/appConfig';

// ─── Hash embedding (legacy fallback) ────────────────────────────────────────

const tokenize = (text: string): string[] =>
    (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1);

const hashToken = (token: string): number => {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
};

const buildHashEmbedding = (text: string): number[] => {
    const dim = embeddingConfig.hash.dimensions;
    const vec = new Array<number>(dim).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vec;
    for (const tok of tokens) {
        vec[hashToken(tok) % dim] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vec : vec.map(v => v / norm);
};

// ─── Nomic Atlas API ──────────────────────────────────────────────────────────

type NomicTaskType = 'search_document' | 'search_query';

interface NomicResponse {
    embeddings: number[][];
    usage?: { prompt_tokens: number };
}

const callNomicApi = async (texts: string[], taskType: NomicTaskType): Promise<number[][]> => {
    const { apiKey, baseUrl, model, batchSize } = embeddingConfig.nomic;

    if (!apiKey) {
        throw new Error(
            'NOMIC_API_KEY is not set. Get a free key at https://atlas.nomic.ai → Settings → API Keys, then add NOMIC_API_KEY=nk-... to your .env'
        );
    }

    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const response = await fetch(`${baseUrl}/embedding/text`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, texts: batch, task_type: taskType }),
        });

        if (!response.ok) {
            const err = await response.text().catch(() => response.statusText);
            throw new Error(`Nomic Atlas error ${response.status}: ${err}`);
        }

        const data = (await response.json()) as NomicResponse;
        if (!Array.isArray(data.embeddings)) {
            throw new Error('Unexpected Nomic response shape: ' + JSON.stringify(data));
        }
        allEmbeddings.push(...data.embeddings);
    }

    return allEmbeddings;
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const embeddingDimensions = (): number => {
    return embeddingConfig.provider === 'nomic'
        ? embeddingConfig.nomic.dimensions
        : embeddingConfig.hash.dimensions;
};

/**
 * Embed one or more document chunks for indexing.
 * Uses task_type=search_document for asymmetric retrieval.
 */
export const embedDocuments = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    if (embeddingConfig.provider === 'hash') return texts.map(buildHashEmbedding);
    return callNomicApi(texts, embeddingConfig.nomic.taskTypeDoc);
};

/**
 * Embed a single search query.
 * Uses task_type=search_query — different vector space from documents.
 */
export const embedQuery = async (text: string): Promise<number[]> => {
    if (embeddingConfig.provider === 'hash') return buildHashEmbedding(text);
    const results = await callNomicApi([text], embeddingConfig.nomic.taskTypeQuery);
    return results[0];
};
