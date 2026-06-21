import { Router } from 'express';
import * as notesController from '../controllers/notesController';
import { verifyToken } from '../middleware/auth';

const router = Router();

// Public — no auth required
router.get('/public', notesController.listPublishedNotes);
router.get('/public/:slug', notesController.getPublishedNote);

router.use(verifyToken);

router.post('/', notesController.createNote);
router.get('/search', notesController.searchNotes);
router.get('/', notesController.getNotes);
router.put('/:id', notesController.updateNote);
router.delete('/:id', notesController.deleteNote);
router.post('/:id/publish', notesController.publishNote);
router.post('/:id/unpublish', notesController.unpublishNote);

export default router;
