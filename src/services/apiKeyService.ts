import crypto from 'crypto';
import { db } from '../config/firebase';

const COLLECTION = 'apiKeys';

/** Generate a new VoiceFlow API key and store it in Firestore */
export const generateApiKey = async (userId: string): Promise<string> => {
    const key = 'vf_' + crypto.randomBytes(24).toString('hex');
    await db.collection(COLLECTION).add({
        key,
        userId,
        createdAt: new Date(),
    });
    return key;
};

/**
 * Validate a key and return the userId it belongs to.
 * Returns null if the key is invalid.
 */
export const validateApiKey = async (key: string): Promise<string | null> => {
    if (!key || !key.startsWith('vf_')) return null;
    const snapshot = await db.collection(COLLECTION)
        .where('key', '==', key)
        .limit(1)
        .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].data().userId as string;
};

/** List all keys for a user (returns preview only — never the full key again) */
export const listApiKeys = async (userId: string) => {
    const snapshot = await db.collection(COLLECTION)
        .where('userId', '==', userId)
        .get();

    return snapshot.docs.map(doc => {
        const data = doc.data();
        const raw = data.key as string;
        return {
            id: doc.id,
            keyPreview: raw.slice(0, 6) + '••••••••' + raw.slice(-4),
            createdAt: data.createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
        };
    });
};

/** Delete (revoke) a key — only if it belongs to the requesting user */
export const deleteApiKey = async (userId: string, keyId: string): Promise<boolean> => {
    const doc = await db.collection(COLLECTION).doc(keyId).get();
    if (!doc.exists || doc.data()?.userId !== userId) return false;
    await doc.ref.delete();
    return true;
};
