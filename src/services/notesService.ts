import { db } from '../config/firebase';

const COLLECTION_NAME = 'notes';

/** Convert any Firestore Timestamp, Date, or ISO string to an ISO string. Returns undefined if falsy. */
const tsToIso = (raw: any): string | undefined => {
    if (!raw) return undefined;
    if (typeof raw.toDate === 'function') return raw.toDate().toISOString();
    if (raw instanceof Date) return raw.toISOString();
    if (typeof raw === 'string') return raw;
    return undefined;
};

export const createNote = async (userId: string, noteData: any) => {
    const now = new Date();
    const docRef = await db.collection(COLLECTION_NAME).add({
        ...noteData,
        userId,
        createdAt: now,
        updatedAt: now
    });
    return {
        id: docRef.id,
        ...noteData,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
    };
};

export const getNotes = async (userId: string) => {
    const snapshot = await db.collection(COLLECTION_NAME)
        .where('userId', '==', userId)
        .get();

    const notes = snapshot.docs.map(doc => {
        const data = doc.data();
        const createdAt = tsToIso(data.createdAt) ?? new Date().toISOString();
        const updatedAt = tsToIso(data.updatedAt) ?? createdAt;
        const embeddingUpdatedAt = tsToIso(data.embeddingUpdatedAt);

        return {
            id: doc.id,
            ...data,
            createdAt,
            updatedAt,
            ...(embeddingUpdatedAt !== undefined ? { embeddingUpdatedAt } : {}),
        };
    });

    return notes.sort((a, b) => {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
};

export const updateNote = async (userId: string, noteId: string, noteData: any) => {
    const now = new Date();
    await db.collection(COLLECTION_NAME).doc(noteId).update({
        ...noteData,
        updatedAt: now
    });
    return {
        id: noteId,
        ...noteData,
        updatedAt: now.toISOString()
    };
};

export const deleteNote = async (userId: string, noteId: string) => {
    await db.collection(COLLECTION_NAME).doc(noteId).delete();
    return { id: noteId };
};

const slugify = (text: string): string =>
    (text || "").toLowerCase().replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";

export const publishNote = async (userId: string, noteId: string, title: string) => {
    const publishedSlug = `${slugify(title)}-${noteId.slice(0, 6)}`;
    const publishedAt = new Date().toISOString();
    await db.collection(COLLECTION_NAME).doc(noteId).update({ isPublished: true, publishedAt, publishedSlug });
    return { publishedSlug, publishedAt };
};

export const unpublishNote = async (userId: string, noteId: string) => {
    await db.collection(COLLECTION_NAME).doc(noteId).update({ isPublished: false, publishedAt: null, publishedSlug: null });
};

export const getPublishedNote = async (slug: string) => {
    const snapshot = await db.collection(COLLECTION_NAME)
        .where('publishedSlug', '==', slug)
        .where('isPublished', '==', true)
        .limit(1)
        .get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    const data = doc.data();
    return {
        id: doc.id,
        title: data.title || 'Untitled',
        text: data.text || '',
        publishedAt: tsToIso(data.publishedAt) ?? '',
    };
};

export const listPublishedNotes = async (folderId?: string) => {
    const snapshot = await db.collection(COLLECTION_NAME)
        .where('isPublished', '==', true)
        .get();

    let notes = snapshot.docs.map(doc => {
        const data = doc.data();
        const excerpt = (data.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        return {
            id: doc.id,
            title: data.title || 'Untitled',
            excerpt,
            publishedSlug: data.publishedSlug || doc.id,
            publishedAt: tsToIso(data.publishedAt) ?? '',
            folderId: data.folderId || null,
            tags: data.tags || [],
        };
    });

    if (folderId === 'root') {
        notes = notes.filter(n => !n.folderId);
    } else if (folderId) {
        notes = notes.filter(n => n.folderId === folderId);
    }

    return notes.sort((a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
};

import * as admin from 'firebase-admin';

export interface SearchFilters {
    q?: string;                // full-text across title / content / tags / aiKeywords
    from?: string;             // ISO date — createdAt >= from
    to?: string;               // ISO date — createdAt <= to
    keywords?: string[];       // must match at least one aiKeyword
    folderId?: string;         // filter by folder; use 'root' for unfiled notes
    includeSubfolders?: boolean; // if true, include all descendant folders (default true)
    limit?: number;            // default 50
    returnType?: 'notes' | 'keywords' | 'both'; // default 'both'
}

const toDate = (raw: any): Date | null => {
    if (!raw) return null;
    if (typeof raw.toDate === 'function') return raw.toDate();
    if (raw instanceof Date) return raw;
    if (typeof raw === 'string') return new Date(raw);
    return null;
};

const stripHtml = (html: string) =>
    (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Parse a date string and set to end-of-day when no time component is provided. */
const parseToDate = (dateStr: string): Date =>
    /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
        ? new Date(dateStr + 'T23:59:59.999Z')
        : new Date(dateStr);

export const searchNotes = async (userId: string, filters: SearchFilters) => {
    let query: admin.firestore.Query = db.collection(COLLECTION_NAME).where('userId', '==', userId);

    if (filters.from) query = query.where('createdAt', '>=', new Date(filters.from));
    if (filters.to)   query = query.where('createdAt', '<=', parseToDate(filters.to));

    const snapshot = await query.get();

    let notes: any[] = snapshot.docs.map(doc => {
        const data = doc.data();
        const createdAt = toDate(data.createdAt)?.toISOString() ?? new Date().toISOString();
        const updatedAt = toDate(data.updatedAt)?.toISOString() ?? createdAt;
        const embeddingUpdatedAt = tsToIso(data.embeddingUpdatedAt);
        return {
            id: doc.id,
            ...data,
            createdAt,
            updatedAt,
            ...(embeddingUpdatedAt !== undefined ? { embeddingUpdatedAt } : {}),
        };
    });

    // In-memory: folder filter
    if (filters.folderId) {
        if (filters.folderId === 'root') {
            // Unfiled notes only
            notes = notes.filter(n => !n.folderId);
        } else if (filters.includeSubfolders !== false) {
            // Include folder + all descendants — load folder list to resolve subtree
            const { getDescendantFolderIds } = await import('./foldersService.js');
            const folderIds = new Set(await getDescendantFolderIds(userId, filters.folderId));
            notes = notes.filter(n => n.folderId && folderIds.has(n.folderId));
        } else {
            // Exact folder only
            notes = notes.filter(n => n.folderId === filters.folderId);
        }
    }

    // In-memory: full-text filter
    if (filters.q?.trim()) {
        const q = filters.q.toLowerCase().trim();
        notes = notes.filter(n =>
            (n.title || '').toLowerCase().includes(q) ||
            stripHtml(n.text || '').toLowerCase().includes(q) ||
            (n.tags || []).join(' ').toLowerCase().includes(q) ||
            (n.aiKeywords || []).join(' ').toLowerCase().includes(q)
        );
    }

    // In-memory: keyword filter
    if (filters.keywords?.length) {
        const kws = filters.keywords.map((k: string) => k.toLowerCase().trim());
        notes = notes.filter(n =>
            (n.aiKeywords || []).some((k: string) => kws.includes(k.toLowerCase().trim()))
        );
    }

    notes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (filters.limit) notes = notes.slice(0, filters.limit);

    return notes;
};
