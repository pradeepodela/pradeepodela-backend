import { Router } from 'express';
import * as feedbackController from '../controllers/feedbackController';
import { verifyToken } from '../middleware/auth';

const router = Router();

router.use(verifyToken);

router.post('/', feedbackController.createFeedback);

export default router;
