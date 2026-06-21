import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import * as foldersService from '../services/foldersService';

export const createFolder = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const folder = await foldersService.createFolder(userId, req.body);
        res.status(201).json(folder);
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const getFolders = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const folders = await foldersService.getFolders(userId);
        res.json(folders);
    } catch (error) {
        console.error('Error fetching folders:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const updateFolder = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { id } = req.params;
        const folder = await foldersService.updateFolder(userId, id as string, req.body);
        res.json(folder);
    } catch (error) {
        console.error('Error updating folder:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const deleteFolder = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user.uid;
        const { id } = req.params;
        await foldersService.deleteFolder(userId, id as string);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting folder:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const getPublicFolders = async (req: any, res: Response) => {
    try {
        const folders = await foldersService.getPublicFolders();
        res.json(folders);
    } catch (error) {
        console.error('Error fetching public folders:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
