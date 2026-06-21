import OpenAI, { toFile } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const groqClient = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || '',
    baseURL: 'https://api.groq.com/openai/v1',
});

const openRouterClient = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY || 'dummy_key',
    baseURL: 'https://openrouter.ai/api/v1',
});

export const generateCompletion = async (
    prompt: string,
    provider: 'groq' | 'openrouter' = 'groq',
    systemMessage?: string
) => {
    const client = provider === 'openrouter' ? openRouterClient : groqClient;
    const model = provider === 'openrouter' ? 'openai/gpt-3.5-turbo' : 'llama-3.3-70b-versatile';

    try {
        const completion = await client.chat.completions.create({
            messages: [
                { role: 'system', content: systemMessage || 'You are a helpful assistant.' },
                { role: 'user', content: prompt }
            ],
            model: model,
        });

        return completion.choices[0]?.message?.content || '';
    } catch (error) {
        console.error(`Error calling AI provider ${provider}:`, error);
        throw new Error('Failed to generate completion');
    }
};

export const transcribeAudio = async (
    buffer: Buffer,
    originalName: string,
    provider: 'groq' | 'openrouter' = 'groq'
) => {
    const client = groqClient;

    try {
        console.log('[DEBUG] aiService: transcribing buffer, size:', buffer.length);

        // Wrap buffer as a File — no disk writes needed, works in Firebase Functions
        const file = await toFile(buffer, originalName || 'audio.webm', { type: 'audio/webm' });

        const transcription = await client.audio.transcriptions.create({
            file,
            model: 'whisper-large-v3',
            response_format: 'json',
            language: 'en',
        });

        console.log('[DEBUG] aiService: transcription result:', JSON.stringify(transcription).substring(0, 50) + '...');

        return transcription.text;
    } catch (error) {
        console.error('Error transcribing audio:', error);
        throw new Error('Failed to transcribe audio');
    }
};
