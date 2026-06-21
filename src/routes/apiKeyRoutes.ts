import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { generate, list, remove } from '../controllers/apiKeyController';

const router = Router();

router.use(verifyToken);

router.post('/generate', generate);
router.get('/', list);
router.delete('/:id', remove);

export default router;
