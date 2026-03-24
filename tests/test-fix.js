
import { convertRequest } from '../src/converter.js';
import { PROVIDERS } from '../src/providers.js';

const mockProvider = PROVIDERS.optimal_sf;

const mockAnthropicRequest = {
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'user', content: 'Hello' },
    { 
      role: 'assistant', 
      content: [
        { type: 'text', text: 'Let me help you.' },
        { type: 'tool_use', id: 'call_1', name: 'ls', input: {} }
      ] 
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt' }
      ]
    }
  ],
  tools: [
    { name: 'ls', description: 'List files', input_schema: { type: 'object' } }
  ]
};

const openaiRequest = convertRequest(mockAnthropicRequest, mockProvider);

console.log('--- OpenAI Request Messages ---');
console.log(JSON.stringify(openaiRequest.messages, null, 2));

const assistantMsg = openaiRequest.messages.find(m => m.role === 'assistant');
if (assistantMsg && assistantMsg.reasoning_content === 'Thought process preserved.') {
  console.log('✅ Success: reasoning_content placeholder injected.');
} else {
  console.log('❌ Failure: reasoning_content placeholder missing or incorrect.');
  process.exit(1);
}
