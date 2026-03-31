import { distillSystemPrompt } from './src/context.js';
import { readFileSync, writeFileSync } from 'fs';

// Helper to handle ESM imports if needed, but we'll try to keep it simple
try {
    const lastRequest = JSON.parse(readFileSync('./last_request.json', 'utf8'));
    const systemPrompt = lastRequest.messages[0].content;
    
    console.log('--- Original Length:', systemPrompt.length);
    
    // Normal distillation
    const d1 = distillSystemPrompt(systemPrompt, true, false);
    console.log('--- Distilled (Normal) Length:', d1.length);
    
    // Small model distillation (Greedy)
    const d2 = distillSystemPrompt(systemPrompt, true, true);
    console.log('--- Distilled (Small Model) Length:', d2.length);
    
    if (d1.length === systemPrompt.length && systemPrompt.length > 15000) {
        console.error('FAILED: Normal distillation did not change a large prompt');
    }
    
    if (d2.length >= d1.length && systemPrompt.length > 0) {
        console.error('FAILED: Small model distillation should be more aggressive');
    }
    
    console.log('--- Sample small model output (First 500 chars):');
    console.log(d2.slice(0, 500));
} catch (err) {
    console.error('Error during verification:', err);
}
