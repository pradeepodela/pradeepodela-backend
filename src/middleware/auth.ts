import { Request, Response, NextFunction } from 'express';
import { auth } from '../config/firebase';

export interface AuthRequest extends Request {
    user?: any;
}

export const verifyToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
    // Support both X-Firebase-Token (used by frontend to bypass Catalyst OAuth)
    // and standard Authorization: Bearer <token>
    const firebaseToken = req.headers['x-firebase-token'] as string;
    const authHeader = req.headers.authorization;

    let token: string | undefined;
    if (firebaseToken) {
        token = firebaseToken;
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split('Bearer ')[1];
    }

    if (!token) {
        return res.status(401).json({ message: 'Unauthorized: No token provided' });
    }

    try {
        const decodedToken = await auth.verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Error verifying token:', error);
        return res.status(403).json({ message: 'Unauthorized: Invalid token' });
    }
};
