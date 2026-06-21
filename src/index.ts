import dotenv from 'dotenv';
import path from 'path';

// Load env vars before ANY other imports
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import aiRoutes from './routes/aiRoutes';
import notesRoutes from './routes/notesRoutes';
import foldersRoutes from './routes/foldersRoutes';
import feedbackRoutes from './routes/feedbackRoutes';
import apiKeyRoutes from './routes/apiKeyRoutes';
import mcpHttpRoute from './routes/mcpHttpRoute';

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = process.env.FRONTEND_ORIGINS
    ? process.env.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : ['http://localhost:8080', 'https://voiceflow-6c4c7.web.app'];

app.use(cors({
    origin: (origin, callback) => {
        // Allow non-browser requests (e.g., curl/postman) with no Origin header.
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked for origin: ${origin}`));
    }
}));
app.use(express.json({ limit: '5mb' }));

// Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Routes
app.use('/api/ai', aiRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/folders', foldersRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/mcp', mcpHttpRoute);

app.get('/', (req, res) => {
    res.send('Voice Flow Backend is running');
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Global exception handlers to prevent exit
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
