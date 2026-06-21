import { getNotes } from './notesService';

export interface NoteRef {
    id: string;
    title: string;
    date: string;
}

export interface KeywordNode {
    keyword: string;
    count: number;
    notes: NoteRef[];
    firstSeen: string;
    lastSeen: string;
}

export interface KeywordEdge {
    source: string;
    target: string;
    weight: number; // number of notes where both co-occur
}

export interface KeywordGraph {
    nodes: KeywordNode[];
    edges: KeywordEdge[];
}

/* ----------------------------------------------------------------
   Core graph builder — works on any pre-fetched/filtered note array.
   Exported so search can build a graph over a date-scoped subset.
---------------------------------------------------------------- */
export const buildGraphFromNotes = (notes: any[]): KeywordGraph => {
    const keywordMap = new Map<string, NoteRef[]>();

    for (const note of notes) {
        const keywords: string[] = (note.aiKeywords || []);
        const date: string = note.updatedAt || note.createdAt;
        const ref: NoteRef = { id: note.id, title: note.title || 'Untitled', date };

        for (const kw of keywords) {
            const k = kw.toLowerCase().trim();
            if (!k) continue;
            if (!keywordMap.has(k)) keywordMap.set(k, []);
            keywordMap.get(k)!.push(ref);
        }
    }

    const nodes: KeywordNode[] = [];
    for (const [keyword, refs] of keywordMap.entries()) {
        const dates = refs.map(r => r.date).sort();
        nodes.push({
            keyword,
            count: refs.length,
            notes: refs,
            firstSeen: dates[0],
            lastSeen: dates[dates.length - 1],
        });
    }

    const edgeMap = new Map<string, number>();
    for (const note of notes) {
        const keywords = (note.aiKeywords || [])
            .map((k: string) => k.toLowerCase().trim())
            .filter(Boolean);

        for (let i = 0; i < keywords.length; i++) {
            for (let j = i + 1; j < keywords.length; j++) {
                const [a, b] = [keywords[i], keywords[j]].sort();
                const key = `${a}|||${b}`;
                edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
            }
        }
    }

    const edges: KeywordEdge[] = [];
    for (const [key, weight] of edgeMap.entries()) {
        const [source, target] = key.split('|||');
        edges.push({ source, target, weight });
    }

    return { nodes, edges };
};

/* ----------------------------------------------------------------
   Build the full keyword co-occurrence graph from a user's notes.
---------------------------------------------------------------- */
export const buildKeywordGraph = async (userId: string): Promise<KeywordGraph> => {
    const notes = await getNotes(userId);
    return buildGraphFromNotes(notes);
};

/* ----------------------------------------------------------------
   Given a keyword, return its direct notes + all related keywords
   (one hop through co-occurrence edges), sorted by connection strength.
---------------------------------------------------------------- */
export const getRelatedConcepts = async (userId: string, keyword: string) => {
    const { nodes, edges } = await buildKeywordGraph(userId);
    const kw = keyword.toLowerCase().trim();

    const node = nodes.find(n => n.keyword === kw);
    if (!node) return { keyword: kw, directNotes: [], relatedKeywords: [] };

    const related: { keyword: string; sharedNotes: number; notes: NoteRef[] }[] = [];

    for (const edge of edges) {
        const other =
            edge.source === kw ? edge.target :
            edge.target === kw ? edge.source :
            null;
        if (!other) continue;

        const otherNode = nodes.find(n => n.keyword === other);
        if (otherNode) {
            related.push({
                keyword: other,
                sharedNotes: edge.weight,
                notes: otherNode.notes,
            });
        }
    }

    related.sort((a, b) => b.sharedNotes - a.sharedNotes);

    return {
        keyword: kw,
        directNotes: node.notes,
        relatedKeywords: related.slice(0, 15),
    };
};

/* ----------------------------------------------------------------
   Temporal pattern analysis:
   - Top keywords by total count + trend (growing / stable / fading)
   - Most active keywords in the last 30 days
   - Weekly keyword timeline (last 8 weeks)
---------------------------------------------------------------- */
export const analyzePatterns = async (userId: string) => {
    const notes: any[] = await getNotes(userId);
    const { nodes } = await buildKeywordGraph(userId);

    const now = Date.now();
    const MS_30 = 30 * 24 * 60 * 60 * 1000;
    const thirtyAgo = new Date(now - MS_30);
    const sixtyAgo  = new Date(now - 2 * MS_30);

    // Top keywords with growth trend
    const topKeywords = [...nodes]
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
        .map(node => {
            const recent = node.notes.filter(n => new Date(n.date) >= thirtyAgo).length;
            const prior  = node.notes.filter(n => new Date(n.date) >= sixtyAgo && new Date(n.date) < thirtyAgo).length;
            const trend: 'growing' | 'stable' | 'fading' =
                recent > prior + 1 ? 'growing' :
                prior  > recent + 1 ? 'fading' :
                'stable';
            return { keyword: node.keyword, count: node.count, recent, prior, trend };
        });

    // Most active last 30 days
    const recentClusters = nodes
        .map(node => ({
            keyword: node.keyword,
            recentCount: node.notes.filter(n => new Date(n.date) >= thirtyAgo).length,
            totalCount: node.count,
        }))
        .filter(k => k.recentCount > 0)
        .sort((a, b) => b.recentCount - a.recentCount)
        .slice(0, 10);

    // Weekly timeline — which keywords appeared each week (last 8 weeks)
    const weekMap = new Map<string, Set<string>>();
    for (const note of notes) {
        const d = new Date(note.updatedAt || note.createdAt);
        const dayOfWeek = d.getDay();
        const diff = d.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const monday = new Date(d);
        monday.setDate(diff);
        const period = monday.toISOString().slice(0, 10);

        if (!weekMap.has(period)) weekMap.set(period, new Set());
        for (const kw of (note.aiKeywords || [])) {
            weekMap.get(period)!.add(kw.toLowerCase().trim());
        }
    }

    const timeline = [...weekMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-8)
        .map(([period, kws]) => ({ period, keywords: [...kws] }));

    return { topKeywords, recentClusters, timeline };
};
