import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import * as feedbackService from '../services/feedbackService';

export const createFeedback = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const feedback = await feedbackService.createFeedback(userId, req.body);
        res.status(201).json(feedback);
    } catch (error) {
        console.error('Error creating feedback:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
