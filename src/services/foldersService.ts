import { db } from '../config/firebase';
import * as admin from 'firebase-admin';

const COLLECTION_NAME = 'folders';

export const createFolder = async (userId: string, folderData: any) => {
    const docRef = await db.collection(COLLECTION_NAME).add({
        ...folderData,
        userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { id: docRef.id, ...folderData };
};

export const getFolders = async (userId: string) => {
    const snapshot = await db.collection(COLLECTION_NAME)
        .where('userId', '==', userId)
        .get();

    const folders = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
            createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
            updatedAt: data.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString()
        };
    });

    // Sort in memory
    return folders.sort((a, b) => {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
};

export const updateFolder = async (userId: string, folderId: string, folderData: any) => {
    await db.collection(COLLECTION_NAME).doc(folderId).update({
        ...folderData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { id: folderId, ...folderData };
};

export const deleteFolder = async (userId: string, folderId: string) => {
    await db.collection(COLLECTION_NAME).doc(folderId).delete();
    return { id: folderId };
};

/**
 * Returns the IDs of a folder AND all its descendants (recursive).
 * Used by search to scope notes to a folder subtree.
 */
export const getDescendantFolderIds = async (userId: string, rootFolderId: string): Promise<string[]> => {
    const allFolders: any[] = await getFolders(userId);

    const collect = (parentId: string): string[] => {
        const ids: string[] = [parentId];
        const children = allFolders.filter(f => f.parentId === parentId);
        for (const child of children) {
            ids.push(...collect(child.id));
        }
        return ids;
    };

    return collect(rootFolderId);
};

export const getPublicFolders = async () => {
    // Collect folder IDs that directly contain a published note
    const notesSnap = await db.collection('notes').where('isPublished', '==', true).get();
    const allFolderIds = new Set<string>();
    notesSnap.docs.forEach(d => { const fid = d.data().folderId; if (fid) allFolderIds.add(fid); });
    if (allFolderIds.size === 0) return [];

    // Walk up the ancestor chain so nested folders render correctly in the hierarchy
    const folderCache = new Map<string, { id: string; name: string; parentId: string | null }>();
    let pending = Array.from(allFolderIds);

    while (pending.length > 0) {
        const nextPending: string[] = [];
        for (let i = 0; i < pending.length; i += 10) {
            const batch = pending.slice(i, i + 10);
            const snap = await db.collection(COLLECTION_NAME)
                .where(admin.firestore.FieldPath.documentId(), 'in', batch)
                .get();
            snap.docs.forEach(doc => {
                const data = doc.data();
                folderCache.set(doc.id, { id: doc.id, name: data.name, parentId: data.parentId || null });
                if (data.parentId && !allFolderIds.has(data.parentId)) {
                    allFolderIds.add(data.parentId);
                    nextPending.push(data.parentId);
                }
            });
        }
        pending = nextPending;
    }

    return Array.from(folderCache.values());
};

/**
 * Returns the full folder tree as a nested structure with note counts.
 * noteCountMap: folderId → count (pass in from caller who has notes loaded)
 */
export const buildFolderTree = (folders: any[], noteCountMap: Record<string, number> = {}) => {
    const build = (parentId: string | null): any[] =>
        folders
            .filter(f => f.parentId === (parentId ?? null))
            .map(f => ({
                id: f.id,
                name: f.name,
                noteCount: noteCountMap[f.id] ?? 0,
                children: build(f.id),
            }));
    return build(null);
};
