import * as admin from 'firebase-admin';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// You should place your service account key in a file named 'serviceAccountKey.json' in the root of the backend folder
// OR set the GOOGLE_APPLICATION_CREDENTIALS environment variable.

try {
    // Check if we have the specific environment variable or file
    // For now, we will try to use application default credentials or a local file
    // If the user hasn't set this up, we'll log a warning

    let serviceAccount;
    const keyPaths = [
        path.resolve(__dirname, '../../serviceAccountKey.json'), // Root of backend
        path.resolve(__dirname, './serviceAccountKey.json'),     // In config folder
        path.resolve(process.cwd(), 'serviceAccountKey.json')    // CWD
    ];

    if (process.env.SERVICE_ACCOUNT_KEY_JSON) {
        try {
            serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
            console.log('Loaded Firebase Service Account from environment variable.');
        } catch (e) {
            console.error('Failed to parse SERVICE_ACCOUNT_KEY_JSON', e);
        }
    } else if (process.env.SERVICE_ACCOUNT_KEY_PATH) {
        serviceAccount = require(path.resolve(process.env.SERVICE_ACCOUNT_KEY_PATH));
    } else {
        for (const p of keyPaths) {
            if (require('fs').existsSync(p)) {
                serviceAccount = require(p);
                console.log(`Found serviceAccountKey.json at: ${p}`);
                break;
            }
        }
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin initialized with service account file.');
    } else {
        admin.initializeApp(); // Tries to use Application Default Credentials
        console.log('Firebase Admin initialized with Application Default Credentials.');
    }

} catch (error) {
    console.error('Error initializing Firebase Admin:', error);
    console.log('Make sure to set up your Firebase Service Account.');
}

export const db = admin.firestore();
export const auth = admin.auth();
