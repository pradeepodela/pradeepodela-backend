import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { generateApiKey, listApiKeys, deleteApiKey } from '../services/apiKeyService';

export const generate = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.uid;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });

        const key = await generateApiKey(userId);
        // Full key is returned ONLY here — never again
        res.json({ key });
    } catch (error) {
        console.error('Error generating API key:', error);
        res.status(500).json({ message: 'Failed to generate API key' });
    }
};

export const list = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.uid;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });

        const keys = await listApiKeys(userId);
        res.json(keys);
    } catch (error) {
        console.error('Error listing API keys:', error);
        res.status(500).json({ message: 'Failed to list API keys' });
    }
};

export const remove = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.uid;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });

        const id = req.params.id as string;
        const deleted = await deleteApiKey(userId, id);

        if (!deleted) return res.status(404).json({ message: 'Key not found or not yours' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting API key:', error);
        res.status(500).json({ message: 'Failed to delete API key' });
    }
};
