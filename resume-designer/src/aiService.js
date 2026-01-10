/**
 * AI Service
 * Unified interface for Anthropic, OpenAI, and Gemini APIs
 */

import { getSettings } from './persistence.js';
import { store } from './store.js';

// API Endpoints
const ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models'
};

// Model configurations
const MODELS = {
  'anthropic:claude-sonnet-4-20250514': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096
  },
  'anthropic:claude-3-5-haiku-20241022': {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    maxTokens: 4096
  },
  'openai:gpt-4o': {
    provider: 'openai',
    model: 'gpt-4o',
    maxTokens: 4096
  },
  'openai:gpt-4o-mini': {
    provider: 'openai',
    model: 'gpt-4o-mini',
    maxTokens: 4096
  },
  'gemini:gemini-2.0-flash': {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    maxTokens: 4096
  },
  'gemini:gemini-1.5-pro': {
    provider: 'gemini',
    model: 'gemini-1.5-pro',
    maxTokens: 4096
  }
};

// System prompt for resume assistant
const SYSTEM_PROMPT = `You are an expert resume consultant and career coach. You help users improve their resumes by:

1. Writing impactful bullet points that highlight achievements and quantifiable results
2. Improving summaries to be compelling and targeted
3. Suggesting better word choices and phrasing
4. Providing feedback on resume structure and content
5. Generating new content based on job descriptions or user requirements

When suggesting changes:
- Be specific and actionable
- Use strong action verbs
- Quantify achievements when possible
- Keep the professional tone appropriate for the industry
- Match the writing style already present in the resume

When asked to rewrite or improve text, provide the improved version directly.
When asked for feedback, be constructive and specific.

Current resume context will be provided with each message.`;

// Get the API key for a provider
function getApiKey(provider) {
  const settings = getSettings();
  switch (provider) {
    case 'anthropic':
      return settings.anthropicKey;
    case 'openai':
      return settings.openaiKey;
    case 'gemini':
      return settings.geminiKey;
    default:
      return null;
  }
}

// Check if a provider is configured
export function isProviderConfigured(provider) {
  const key = getApiKey(provider);
  return key && key.length > 0;
}

// Get configured providers
export function getConfiguredProviders() {
  return ['anthropic', 'openai', 'gemini'].filter(p => isProviderConfigured(p));
}

// Get resume context for AI
function getResumeContext() {
  const data = store.getData();
  if (!data) return 'No resume is currently loaded.';
  
  let context = `Current Resume:\n\n`;
  context += `Name: ${data.name}\n`;
  context += `Title: ${data.tagline}\n\n`;
  
  if (data.summary) {
    context += `Summary:\n${data.summary}\n\n`;
  }
  
  if (data.sections && data.sections.length > 0) {
    for (const section of data.sections) {
      context += `${section.title}:\n`;
      if (Array.isArray(section.content)) {
        context += section.content.join('\n') + '\n';
      }
      context += '\n';
    }
  }
  
  if (data.experience && data.experience.length > 0) {
    context += `Experience:\n`;
    for (const exp of data.experience) {
      context += `- ${exp.title} at ${exp.company} (${exp.dates})\n`;
      if (exp.bullets) {
        for (const bullet of exp.bullets) {
          context += `  • ${bullet}\n`;
        }
      }
    }
    context += '\n';
  }
  
  if (data.education && data.education.length > 0) {
    context += `Education:\n`;
    for (const edu of data.education) {
      context += `- ${edu}\n`;
    }
  }
  
  return context;
}

// Call Anthropic API
async function callAnthropic(modelConfig, messages, apiKey) {
  const response = await fetch(ENDPOINTS.anthropic, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: modelConfig.model,
      max_tokens: modelConfig.maxTokens,
      system: SYSTEM_PROMPT,
      messages: messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      }))
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Anthropic API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.content[0].text;
}

// Call OpenAI API
async function callOpenAI(modelConfig, messages, apiKey) {
  const response = await fetch(ENDPOINTS.openai, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelConfig.model,
      max_tokens: modelConfig.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      ]
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// Call Gemini API
async function callGemini(modelConfig, messages, apiKey) {
  const url = `${ENDPOINTS.gemini}/${modelConfig.model}:generateContent?key=${apiKey}`;
  
  // Convert messages to Gemini format
  const contents = [];
  
  // Add system instruction as first user message context
  const systemContext = SYSTEM_PROMPT;
  
  for (const msg of messages) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents,
      systemInstruction: {
        parts: [{ text: systemContext }]
      },
      generationConfig: {
        maxOutputTokens: modelConfig.maxTokens
      }
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Gemini API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// Main chat function
export async function chat(modelId, messages, includeContext = true) {
  const modelConfig = MODELS[modelId];
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  
  const apiKey = getApiKey(modelConfig.provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${modelConfig.provider}. Please add your API key in settings.`);
  }
  
  // Inject resume context into the first user message if enabled
  let processedMessages = [...messages];
  if (includeContext && processedMessages.length > 0) {
    const context = getResumeContext();
    const lastUserIndex = processedMessages.map(m => m.role).lastIndexOf('user');
    if (lastUserIndex >= 0) {
      processedMessages[lastUserIndex] = {
        ...processedMessages[lastUserIndex],
        content: `${context}\n\n---\n\nUser request: ${processedMessages[lastUserIndex].content}`
      };
    }
  }
  
  // Call the appropriate API
  switch (modelConfig.provider) {
    case 'anthropic':
      return callAnthropic(modelConfig, processedMessages, apiKey);
    case 'openai':
      return callOpenAI(modelConfig, processedMessages, apiKey);
    case 'gemini':
      return callGemini(modelConfig, processedMessages, apiKey);
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`);
  }
}

// Helper functions for common operations
export async function rewriteText(modelId, text, instruction = 'Improve this text to be more impactful and professional') {
  const messages = [{
    role: 'user',
    content: `${instruction}:\n\n"${text}"\n\nProvide only the improved text without any explanation.`
  }];
  
  return chat(modelId, messages, true);
}

export async function generateBullets(modelId, context, count = 3) {
  const messages = [{
    role: 'user',
    content: `Based on the resume and this context: "${context}", generate ${count} impactful bullet points. Format as a numbered list.`
  }];
  
  return chat(modelId, messages, true);
}

export async function getFeedback(modelId) {
  const messages = [{
    role: 'user',
    content: `Please review my resume and provide constructive feedback. Focus on:
1. Overall impression and strengths
2. Areas for improvement
3. Specific suggestions for each section
4. Any missing elements that would strengthen the resume`
  }];
  
  return chat(modelId, messages, true);
}

export async function improveSummary(modelId) {
  const messages = [{
    role: 'user',
    content: `Please rewrite my resume summary to be more compelling and impactful. Make it concise but powerful, highlighting key strengths and value proposition. Provide only the improved summary text.`
  }];
  
  return chat(modelId, messages, true);
}
