
import { convertRequest } from '../src/converter.js';
import { PROVIDERS } from '../src/providers.js';

const mockProvider = PROVIDERS.optimal_sf;

console.log('--- Test Case 1: Native Thinking Block ---');
const req1 = {
  model: 'claude-sonnet-4-5',
  messages: [
    { 
      role: 'assistant', 
      content: [
        { type: 'thinking', thinking: 'Native thinking' },
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'call_1', name: 'ls', input: {} }
      ] 
    }
  ],
  tools: [{ name: 'ls', description: 'ls', input_schema: { type: 'object' } }]
};
const res1 = convertRequest(req1, mockProvider);
console.log('res1 reasoning:', JSON.stringify(res1.messages[1].reasoning_content));
if (res1.messages[1].reasoning_content === 'Native thinking') console.log('✅ Pass');
else { console.log('❌ Fail'); process.exit(1); }

console.log('\n--- Test Case 2: Thinking in <think> tags ---');
const req2 = {
  model: 'claude-sonnet-4-5',
  messages: [
    { 
      role: 'assistant', 
      content: [
        { type: 'text', text: '<think>Extracted thinking</think>Visible text' },
        { type: 'tool_use', id: 'call_2', name: 'ls', input: {} }
      ] 
    }
  ],
  tools: [{ name: 'ls', description: 'ls', input_schema: { type: 'object' } }]
};
const res2 = convertRequest(req2, mockProvider);
console.log('res2 reasoning:', JSON.stringify(res2.messages[1].reasoning_content));
console.log('res2 content:', JSON.stringify(res2.messages[1].content));
if (res2.messages[1].reasoning_content === 'Extracted thinking' && res2.messages[1].content === 'Visible text') console.log('✅ Pass');
else { console.log('❌ Fail'); process.exit(1); }

console.log('\n--- Test Case 3: Empty Reasoning Placeholder ---');
const req3 = {
  model: 'claude-sonnet-4-5',
  messages: [
    { 
      role: 'assistant', 
      content: [
        { type: 'text', text: 'Just text' },
        { type: 'tool_use', id: 'call_3', name: 'ls', input: {} }
      ] 
    }
  ],
  tools: [{ name: 'ls', description: 'ls', input_schema: { type: 'object' } }]
};
const res3 = convertRequest(req3, mockProvider);
console.log('res3 reasoning:', JSON.stringify(res3.messages[1].reasoning_content));
if (res3.messages[1].reasoning_content === ' ') console.log('✅ Pass');
else { console.log('❌ Fail'); process.exit(1); }

console.log('\n--- Test Case 4: History Sanitization (Old Placeholder) ---');
const req4 = {
  model: 'claude-sonnet-4-5',
  messages: [
    { 
      role: 'assistant', 
      content: [
        { type: 'text', text: 'Old response' },
        { type: 'thinking', thinking: 'Thought process preserved.' }
      ] 
    }
  ]
};
const res4 = convertRequest(req4, mockProvider);
console.log('res4 reasoning:', JSON.stringify(res4.messages[1].reasoning_content));
if (res4.messages[1].reasoning_content === ' ') console.log('✅ Pass');
else { console.log('❌ Fail'); process.exit(1); }
