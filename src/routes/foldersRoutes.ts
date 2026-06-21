import { Router } from 'express';
import * as foldersController from '../controllers/foldersController';
import { verifyToken } from '../middleware/auth';

const router = Router();

router.get('/public', foldersController.getPublicFolders);

router.use(verifyToken);

router.post('/', foldersController.createFolder);
router.get('/', foldersController.getFolders);
router.put('/:id', foldersController.updateFolder);
router.delete('/:id', foldersController.deleteFolder);

export default router;
