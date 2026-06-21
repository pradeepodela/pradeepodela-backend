import { db } from '../config/firebase';
import * as admin from 'firebase-admin';

const COLLECTION_NAME = 'feedback';

export const createFeedback = async (userId: string, feedbackData: any) => {
    const docRef = await db.collection(COLLECTION_NAME).add({
        ...feedbackData,
        userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { id: docRef.id, ...feedbackData };
};
