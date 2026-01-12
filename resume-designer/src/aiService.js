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

// Model configurations - Model IDs verified from provider documentation
const MODELS = {
  'anthropic:claude-opus-4-5': {
    provider: 'anthropic',
    model: 'claude-opus-4-5-20251101',
    maxTokens: 8192
  },
  'anthropic:claude-sonnet-4-5': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 8192
  },
  'anthropic:claude-haiku-4-5': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096
  },
  'openai:gpt-5.2': {
    provider: 'openai',
    model: 'gpt-5.2',
    maxTokens: 8192
  },
  'openai:gpt-5.2-pro': {
    provider: 'openai',
    model: 'gpt-5.2-pro',
    maxTokens: 16384
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
  'gemini:gemini-3-pro': {
    provider: 'gemini',
    model: 'gemini-3-pro',
    maxTokens: 8192
  },
  'gemini:gemini-3-flash': {
    provider: 'gemini',
    model: 'gemini-3-flash',
    maxTokens: 8192
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

// System prompt for generating structured changes
const CHANGE_GENERATION_PROMPT = `You are an expert resume consultant. When asked to modify a resume, you MUST respond with a valid JSON object containing the changes to make.

The JSON response format must be:
{
  "changes": {
    "path.to.field": "new value",
    "another.path": "another value"
  },
  "explanation": "Brief explanation of what was changed and why"
}

Valid paths include:
- "name" - the person's name
- "tagline" - professional title
- "summary" - professional summary
- "experience[0].title" - job title for first experience
- "experience[0].company" - company name for first experience  
- "experience[0].bullets[0]" - first bullet for first experience
- "sections[0].content[0]" - first item in first sidebar section
- And similar nested paths using dot notation and array indices

Rules:
1. ONLY output valid JSON - no markdown, no explanation outside the JSON
2. Include all fields that should be changed
3. For array items, use numeric indices like experience[0].bullets[1]
4. Keep unchanged fields out of the response
5. The explanation field should be inside the JSON`;

// System prompt for job description analysis
const JOB_ANALYSIS_PROMPT = `You are an expert resume consultant and ATS (Applicant Tracking System) specialist. Analyze resumes against job descriptions to help candidates improve their match rate.

When analyzing:
1. Identify key skills, qualifications, and keywords from the job description
2. Compare against the resume content
3. Calculate a match score (0-100)
4. Identify gaps and missing keywords
5. Provide specific, actionable recommendations

Respond in the following JSON format:
{
  "matchScore": 75,
  "keywordMatches": ["keyword1", "keyword2"],
  "missingKeywords": ["keyword3", "keyword4"],
  "gaps": [
    {"area": "Skills", "issue": "Missing X technology", "suggestion": "Add X to skills section"}
  ],
  "strengths": ["Strong experience in Y", "Good quantified achievements"],
  "recommendations": [
    {"section": "summary", "current": "current text", "suggested": "improved text", "reason": "why this change helps"}
  ]
}`;

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
      max_completion_tokens: modelConfig.maxTokens, // Use max_completion_tokens instead of deprecated max_tokens
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

/**
 * Generate structured resume changes that can be displayed in a diff view
 * @param {string} modelId - Model to use
 * @param {string} instruction - User's instruction for what to change
 * @param {string} targetPath - Optional specific path to target (e.g., "summary", "experience[0]")
 * @param {Object} additionalContext - Optional additional context like job descriptions
 * @returns {Object} Object with changes and explanation
 */
export async function generateResumeChanges(modelId, instruction, targetPath = null, additionalContext = null) {
  const modelConfig = MODELS[modelId];
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  
  const apiKey = getApiKey(modelConfig.provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${modelConfig.provider}. Please add your API key in settings.`);
  }
  
  const resumeData = store.getData();
  if (!resumeData) {
    throw new Error('No resume data available');
  }
  
  // Build the prompt
  let prompt = `Here is the current resume data as JSON:\n\n${JSON.stringify(resumeData, null, 2)}\n\n`;
  
  if (additionalContext?.jobDescriptions) {
    prompt += `Target job descriptions:\n`;
    for (const jd of additionalContext.jobDescriptions) {
      prompt += `\n--- ${jd.title} at ${jd.company} ---\n${jd.description}\n`;
    }
    prompt += '\n';
  }
  
  prompt += `User request: ${instruction}\n`;
  
  if (targetPath) {
    prompt += `\nFocus specifically on the field at path: ${targetPath}\n`;
  }
  
  prompt += `\nRespond with ONLY a valid JSON object in the format specified. No markdown formatting, no code blocks, just the raw JSON.`;
  
  // Call AI with the change generation system prompt
  let response;
  const messages = [{ role: 'user', content: prompt }];
  
  switch (modelConfig.provider) {
    case 'anthropic':
      response = await callAnthropicWithSystem(modelConfig, messages, apiKey, CHANGE_GENERATION_PROMPT);
      break;
    case 'openai':
      response = await callOpenAIWithSystem(modelConfig, messages, apiKey, CHANGE_GENERATION_PROMPT);
      break;
    case 'gemini':
      response = await callGeminiWithSystem(modelConfig, messages, apiKey, CHANGE_GENERATION_PROMPT);
      break;
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`);
  }
  
  // Parse the JSON response
  try {
    // Try to extract JSON from the response (handle markdown code blocks if present)
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }
    
    const result = JSON.parse(jsonStr);
    return {
      changes: result.changes || {},
      explanation: result.explanation || 'Changes generated successfully'
    };
  } catch (e) {
    console.error('Failed to parse AI response as JSON:', response);
    throw new Error('AI response was not valid JSON. Please try again.');
  }
}

// API calls with custom system prompts
async function callAnthropicWithSystem(modelConfig, messages, apiKey, systemPrompt) {
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
      system: systemPrompt,
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

async function callOpenAIWithSystem(modelConfig, messages, apiKey, systemPrompt) {
  const response = await fetch(ENDPOINTS.openai, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelConfig.model,
      max_completion_tokens: modelConfig.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
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

async function callGeminiWithSystem(modelConfig, messages, apiKey, systemPrompt) {
  const url = `${ENDPOINTS.gemini}/${modelConfig.model}:generateContent?key=${apiKey}`;
  
  const contents = messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents,
      systemInstruction: {
        parts: [{ text: systemPrompt }]
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

/**
 * Analyze resume against job descriptions
 * @param {string} modelId - Model to use
 * @param {Array} jobDescriptions - Array of job description objects
 * @returns {Object} Analysis results
 */
export async function analyzeAgainstJobs(modelId, jobDescriptions) {
  const modelConfig = MODELS[modelId];
  if (!modelConfig) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  
  const apiKey = getApiKey(modelConfig.provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${modelConfig.provider}. Please add your API key in settings.`);
  }
  
  const resumeData = store.getData();
  if (!resumeData) {
    throw new Error('No resume data available');
  }
  
  let prompt = `Analyze this resume against the target job description(s).\n\n`;
  prompt += `Resume:\n${JSON.stringify(resumeData, null, 2)}\n\n`;
  prompt += `Job Descriptions:\n`;
  
  for (const jd of jobDescriptions) {
    prompt += `\n--- ${jd.title} at ${jd.company} ---\n${jd.description}\n`;
  }
  
  prompt += `\nProvide your analysis as a JSON object. No markdown, just raw JSON.`;
  
  const messages = [{ role: 'user', content: prompt }];
  
  let response;
  switch (modelConfig.provider) {
    case 'anthropic':
      response = await callAnthropicWithSystem(modelConfig, messages, apiKey, JOB_ANALYSIS_PROMPT);
      break;
    case 'openai':
      response = await callOpenAIWithSystem(modelConfig, messages, apiKey, JOB_ANALYSIS_PROMPT);
      break;
    case 'gemini':
      response = await callGeminiWithSystem(modelConfig, messages, apiKey, JOB_ANALYSIS_PROMPT);
      break;
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`);
  }
  
  try {
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse analysis response:', response);
    throw new Error('Failed to parse AI analysis. Please try again.');
  }
}

/**
 * Generate tailored resume content for a specific job
 * @param {string} modelId - Model to use
 * @param {Object} jobDescription - Job description object
 * @param {string} section - Section to tailor (e.g., "summary", "experience")
 * @returns {Object} Tailored changes
 */
export async function tailorForJob(modelId, jobDescription, section = null) {
  const instruction = section 
    ? `Tailor the ${section} section specifically for this job. Make it highlight relevant skills and experience that match the job requirements.`
    : `Tailor my entire resume for this job. Adjust the summary, highlight relevant experience, and ensure keywords from the job description are naturally incorporated.`;
  
  return generateResumeChanges(modelId, instruction, section, {
    jobDescriptions: [jobDescription]
  });
}

/**
 * Get available models for a specific provider
 * @param {string} provider - Provider name
 * @returns {Array} Array of model info objects
 */
export function getModelsForProvider(provider) {
  return Object.entries(MODELS)
    .filter(([, config]) => config.provider === provider)
    .map(([id, config]) => ({
      id,
      model: config.model,
      provider: config.provider
    }));
}

/**
 * Get all available models
 * @returns {Object} Models grouped by provider
 */
export function getAllModels() {
  const grouped = { anthropic: [], openai: [], gemini: [] };
  
  for (const [id, config] of Object.entries(MODELS)) {
    grouped[config.provider].push({
      id,
      model: config.model,
      provider: config.provider
    });
  }
  
  return grouped;
}
