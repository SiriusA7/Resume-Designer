/**
 * AI Service
 * Unified interface for Anthropic, OpenAI, and Gemini APIs
 */

import { getSettings, getUserProfile, saveUserProfile } from './persistence.js';
import { store } from './store.js';
import { getActiveJobDescriptions } from './jobDescriptions.js';
import { trackUsage } from './tokenTrackingService.js';

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
5. Provide specific, actionable recommendations with impact ratings

For each recommendation, assess its potential IMPACT on improving resume fit:
- "high": Critical changes that address major keyword gaps, missing required skills, or significantly improve ATS match rate
- "medium": Important improvements that enhance relevance but aren't critical requirements
- "low": Nice-to-have optimizations that provide marginal improvements

Order recommendations by impact (high first, then medium, then low).

If user background information is provided, use it to suggest more personalized and accurate improvements based on their actual experience and skills.

IMPORTANT for recommendations:
- For MODIFYING existing content: set "current" to the exact text being replaced
- For ADDING new content (new bullet points, skills, etc.): set "current" to "N/A" or "Add new"
- For adding bullets to experience: use section name like "Experience - [Company Name]" or "Experience bullet"
- For adding skills: use section name "Skills"

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
    {
      "section": "summary",
      "current": "current text to replace (or 'N/A' if adding new)",
      "suggested": "improved or new text",
      "reason": "why this change helps",
      "impact": "high",
      "impactReason": "Addresses critical keyword gap for required skill"
    }
  ]
}`;

// System prompt for profile interview
const PROFILE_INTERVIEW_PROMPT = `You are a friendly career coach conducting an interview to learn about someone's professional background. Your goal is to gather detailed information that will help create better resumes.

Interview Guidelines:
1. Be conversational and encouraging
2. Ask follow-up questions to get specific details (numbers, technologies, impact)
3. Cover these areas naturally: career goals, work experience details, skills, education, projects, achievements
4. Don't ask all questions at once - have a natural back-and-forth conversation
5. When you have enough information, offer to summarize what you've learned

Start by introducing yourself briefly and asking about their current role or what kind of work they're looking for.`;

// System prompt for extracting profile data from conversation
const PROFILE_EXTRACTION_PROMPT = `Extract structured profile information from the following conversation. Return ONLY valid JSON with no markdown formatting.

The JSON structure should be:
{
  "personalSummary": "A 2-3 sentence professional summary based on what was discussed",
  "careerGoals": "Their stated career goals and what they're looking for",
  "workExperience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "dates": "Date range if mentioned",
      "details": "Detailed description of responsibilities, achievements, technologies used, team size, impact"
    }
  ],
  "skills": [
    {"name": "Skill Name", "proficiency": "beginner|intermediate|advanced|expert", "years": "X"}
  ],
  "education": [
    {
      "degree": "Degree/Program",
      "institution": "School Name",
      "dates": "Year or date range",
      "details": "Notable courses, projects, honors"
    }
  ],
  "projects": [
    {"name": "Project Name", "url": "", "description": "Description of the project"}
  ],
  "certifications": [
    {"name": "Certification Name", "year": "Year"}
  ],
  "achievements": [
    {"description": "Achievement description"}
  ],
  "industryKnowledge": "Domains, methodologies, tools they're familiar with",
  "preferences": "Work preferences, industries of interest, location preferences"
}

Rules:
1. Only include fields where information was actually discussed
2. Use empty arrays [] for sections with no information
3. Be specific and detailed based on what was shared
4. Infer proficiency levels from context clues
5. Output ONLY the JSON, no explanation`;

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

// Get the default model ID based on configured providers
export function getDefaultModelId() {
  const providers = getConfiguredProviders();
  if (providers.includes('anthropic')) {
    return 'anthropic:claude-sonnet-4-5';
  }
  if (providers.includes('openai')) {
    return 'openai:gpt-5.2';
  }
  if (providers.includes('gemini')) {
    return 'gemini:gemini-3-flash';
  }
  return null;
}

// Validate and migrate a model ID - returns valid model ID or fallback
export function validateModelId(modelId) {
  // If model exists in config, use it
  if (MODELS[modelId]) {
    return modelId;
  }
  
  // Try to find a fallback based on the provider
  const provider = modelId?.split(':')[0];
  if (provider && isProviderConfigured(provider)) {
    // Return default model for this provider
    const fallbacks = {
      'anthropic': 'anthropic:claude-sonnet-4-5',
      'openai': 'openai:gpt-5.2',
      'gemini': 'gemini:gemini-3-flash'
    };
    console.warn(`Model "${modelId}" not found, falling back to ${fallbacks[provider]}`);
    return fallbacks[provider];
  }
  
  // Return any available default
  return getDefaultModelId();
}

// Get list of available model IDs
export function getAvailableModelIds() {
  return Object.keys(MODELS);
}

// Check if user profile has meaningful content
function isProfileEmpty(profile) {
  if (!profile) return true;
  
  // Check text fields
  const textFields = ['personalSummary', 'careerGoals', 'preferences', 'industryKnowledge'];
  for (const field of textFields) {
    if (profile[field] && profile[field].trim().length > 0) return false;
  }
  
  // Check array fields
  const arrayFields = ['workExperience', 'skills', 'education', 'projects', 'certifications', 'achievements', 'customSections'];
  for (const field of arrayFields) {
    if (profile[field] && profile[field].length > 0) return false;
  }
  
  return true;
}

// Get user profile context for AI
function getUserProfileContext() {
  const profile = getUserProfile();
  console.log('[AI Context] User profile loaded:', profile);
  
  if (!profile || isProfileEmpty(profile)) {
    console.log('[AI Context] User profile is empty or null');
    return '';
  }
  
  console.log('[AI Context] User profile has content, building context...');
  
  let context = `## User Background Information\n\n`;
  context += `The following is detailed background information about the user that should inform your resume suggestions:\n\n`;
  
  if (profile.personalSummary && profile.personalSummary.trim()) {
    context += `### Personal Summary\n${profile.personalSummary.trim()}\n\n`;
  }
  
  if (profile.careerGoals && profile.careerGoals.trim()) {
    context += `### Career Goals\n${profile.careerGoals.trim()}\n\n`;
  }
  
  if (profile.preferences && profile.preferences.trim()) {
    context += `### Preferences\n${profile.preferences.trim()}\n\n`;
  }
  
  if (profile.workExperience && profile.workExperience.length > 0) {
    context += `### Detailed Work Experience\n`;
    for (const exp of profile.workExperience) {
      if (exp.title || exp.company) {
        context += `\n**${exp.title || 'Untitled'}** at ${exp.company || 'Unknown Company'}`;
        if (exp.dates) context += ` (${exp.dates})`;
        context += `\n`;
        if (exp.details) context += `${exp.details}\n`;
      }
    }
    context += '\n';
  }
  
  if (profile.skills && profile.skills.length > 0) {
    context += `### Skills Inventory\n`;
    for (const skill of profile.skills) {
      if (skill.name) {
        let skillLine = `- ${skill.name}`;
        if (skill.proficiency) skillLine += ` (${skill.proficiency})`;
        if (skill.years) skillLine += ` - ${skill.years} years`;
        context += skillLine + '\n';
      }
    }
    context += '\n';
  }
  
  if (profile.industryKnowledge && profile.industryKnowledge.trim()) {
    context += `### Industry Knowledge\n${profile.industryKnowledge.trim()}\n\n`;
  }
  
  if (profile.education && profile.education.length > 0) {
    context += `### Education Details\n`;
    for (const edu of profile.education) {
      if (edu.degree || edu.institution) {
        context += `\n**${edu.degree || 'Unknown Degree'}** - ${edu.institution || 'Unknown Institution'}`;
        if (edu.dates) context += ` (${edu.dates})`;
        context += `\n`;
        if (edu.details) context += `${edu.details}\n`;
      }
    }
    context += '\n';
  }
  
  if (profile.projects && profile.projects.length > 0) {
    context += `### Projects & Portfolio\n`;
    for (const proj of profile.projects) {
      if (proj.name) {
        context += `\n**${proj.name}**`;
        if (proj.url) context += ` (${proj.url})`;
        context += `\n`;
        if (proj.description) context += `${proj.description}\n`;
      }
    }
    context += '\n';
  }
  
  if (profile.certifications && profile.certifications.length > 0) {
    context += `### Certifications\n`;
    for (const cert of profile.certifications) {
      if (cert.name) {
        context += `- ${cert.name}`;
        if (cert.year) context += ` (${cert.year})`;
        context += '\n';
      }
    }
    context += '\n';
  }
  
  if (profile.achievements && profile.achievements.length > 0) {
    context += `### Achievements\n`;
    for (const ach of profile.achievements) {
      if (ach.description) {
        context += `- ${ach.description}\n`;
      }
    }
    context += '\n';
  }
  
  if (profile.customSections && profile.customSections.length > 0) {
    for (const section of profile.customSections) {
      if (section.title && section.content) {
        context += `### ${section.title}\n${section.content}\n\n`;
      }
    }
  }
  
  return context;
}

// Get active job descriptions context for AI
function getJobDescriptionsContext() {
  try {
    const activeJDs = getActiveJobDescriptions();
    if (!activeJDs || activeJDs.length === 0) return '';
    
    let context = `## Target Job Descriptions\n\n`;
    context += `The user is targeting the following job(s). Use this information to make suggestions more relevant:\n\n`;
    
    for (const jd of activeJDs) {
      context += `### ${jd.title} at ${jd.company}\n`;
      context += `${jd.description}\n\n`;
    }
    
    console.log('[AI Context] Job descriptions included:', activeJDs.length);
    return context;
  } catch (e) {
    // jobDescriptions module may not be initialized yet
    console.log('[AI Context] Job descriptions not available:', e.message);
    return '';
  }
}

// Get resume context for AI
function getResumeContext() {
  const data = store.getData();
  
  // Start with user profile context (if available)
  let context = getUserProfileContext();
  
  // Add active job descriptions context (if any)
  context += getJobDescriptionsContext();
  
  if (!data) {
    return context + '\nNo resume is currently loaded.';
  }
  
  context += `## Current Resume\n\n`;
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

// Map reasoning effort levels to Anthropic thinking budget tokens
const ANTHROPIC_THINKING_BUDGETS = {
  'low': 1024,      // Minimum required
  'medium': 4096,   // Moderate thinking
  'high': 8192      // Extended thinking
};

// Call Anthropic API
async function callAnthropic(modelConfig, messages, apiKey, options = {}) {
  const { reasoningEffort, webSearch } = options;
  
  const requestBody = {
    model: modelConfig.model,
    max_tokens: modelConfig.maxTokens,
    system: SYSTEM_PROMPT,
    messages: messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }))
  };
  
  // Add extended thinking if reasoning effort is specified
  // Note: Extended thinking requires max_tokens > budget_tokens
  if (reasoningEffort && reasoningEffort !== 'none' && ANTHROPIC_THINKING_BUDGETS[reasoningEffort]) {
    const budgetTokens = ANTHROPIC_THINKING_BUDGETS[reasoningEffort];
    // Ensure max_tokens is greater than budget_tokens
    requestBody.max_tokens = Math.max(modelConfig.maxTokens, budgetTokens + 2048);
    requestBody.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens
    };
  }
  
  // Add web search tool if enabled
  // Uses the web_search_20250305 tool type
  if (webSearch) {
    requestBody.tools = [
      {
        type: 'web_search_20250305',
        name: 'web_search'
      }
    ];
  }
  
  const response = await fetch(ENDPOINTS.anthropic, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Anthropic API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Track token usage
  if (data.usage) {
    trackUsage({
      provider: 'anthropic',
      model: modelConfig.model,
      feature: options.feature || 'chat',
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
      cacheRead: data.usage.cache_read_input_tokens || 0,
      cacheCreation: data.usage.cache_creation_input_tokens || 0
    });
  }
  
  // Handle response with extended thinking or tool use (may have multiple content blocks)
  if (Array.isArray(data.content)) {
    // Extract thinking/reasoning summary if present
    const thinkingBlock = data.content.find(block => block.type === 'thinking');
    const thinkingSummary = thinkingBlock?.thinking || null;
    
    // Find the text content block (not the thinking block or tool_use block)
    const textBlock = data.content.find(block => block.type === 'text');
    const text = textBlock?.text || '';
    
    // If there's a web search result, note it
    const webSearchResult = data.content.find(block => block.type === 'web_search_tool_result');
    const usedWebSearch = !!webSearchResult;
    
    // Return structured response if we have thinking or web search
    if (thinkingSummary || usedWebSearch) {
      return {
        text: text || data.content.find(block => block.text)?.text || JSON.stringify(data.content),
        thinking: thinkingSummary,
        usedWebSearch
      };
    }
    
    // Fallback to simple text
    return text || data.content[0]?.text || JSON.stringify(data.content);
  }
  
  return data.content[0].text;
}

// Map our reasoning levels to OpenAI reasoning_effort values
const OPENAI_REASONING_EFFORT = {
  'none': 'none',
  'low': 'low',
  'medium': 'medium',
  'high': 'high'
};

// OpenAI search-enabled model mappings
// When web search is enabled, we can use search-preview models for gpt-4o variants
const OPENAI_SEARCH_MODELS = {
  'gpt-4o': 'gpt-4o-search-preview',
  'gpt-4o-mini': 'gpt-4o-mini-search-preview'
};

// Call OpenAI API (routes to appropriate endpoint based on model)
async function callOpenAI(modelConfig, messages, apiKey, options = {}) {
  const { reasoningEffort, webSearch } = options;
  
  // GPT-5.x models require the Responses API (not Chat Completions)
  const isGpt5 = modelConfig.model.startsWith('gpt-5');
  if (isGpt5) {
    return callOpenAIResponses(modelConfig, messages, apiKey, options);
  }
  
  // Determine which model to use
  let modelToUse = modelConfig.model;
  
  // For web search with gpt-4o models, use search-preview variants
  if (webSearch && OPENAI_SEARCH_MODELS[modelConfig.model]) {
    modelToUse = OPENAI_SEARCH_MODELS[modelConfig.model];
  }
  
  // Check if this is an o1 reasoning model (uses 'developer' role instead of 'system')
  const isO1Model = modelConfig.model.startsWith('o1');
  
  // Build messages array - o1 models use 'developer' role instead of 'system'
  const apiMessages = isO1Model 
    ? [
        { role: 'developer', content: SYSTEM_PROMPT },
        ...messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      ]
    : [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      ];
  
  const requestBody = {
    model: modelToUse,
    max_completion_tokens: modelConfig.maxTokens,
    messages: apiMessages
  };
  
  // Add reasoning_effort for o1 models
  if (reasoningEffort && OPENAI_REASONING_EFFORT[reasoningEffort] && isO1Model) {
    requestBody.reasoning_effort = OPENAI_REASONING_EFFORT[reasoningEffort];
  }
  
  const response = await fetch(ENDPOINTS.openai, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Track token usage
  if (data.usage) {
    trackUsage({
      provider: 'openai',
      model: modelToUse,
      feature: options.feature || 'chat',
      inputTokens: data.usage.prompt_tokens || 0,
      outputTokens: data.usage.completion_tokens || 0
    });
  }
  
  return data.choices[0].message.content;
}

// Call OpenAI Responses API (for GPT-5 with web search and reasoning)
async function callOpenAIResponses(modelConfig, messages, apiKey, options = {}) {
  const { reasoningEffort, webSearch } = options;
  
  // Build input from messages
  const input = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content
  }));
  
  // Add system message context to first user message
  if (input.length > 0 && input[0].role === 'user') {
    input[0].content = `${SYSTEM_PROMPT}\n\n${input[0].content}`;
  }
  
  const requestBody = {
    model: modelConfig.model,
    input: input
  };
  
  // Add reasoning configuration
  if (reasoningEffort && OPENAI_REASONING_EFFORT[reasoningEffort]) {
    requestBody.reasoning = {
      effort: OPENAI_REASONING_EFFORT[reasoningEffort]
    };
  }
  
  // Add web search tool
  if (webSearch) {
    requestBody.tools = [{ type: 'web_search' }];
  }
  
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Track token usage
  if (data.usage) {
    trackUsage({
      provider: 'openai',
      model: modelConfig.model,
      feature: options.feature || 'chat',
      inputTokens: data.usage.input_tokens || data.usage.prompt_tokens || 0,
      outputTokens: data.usage.output_tokens || data.usage.completion_tokens || 0
    });
  }
  
  // Responses API returns output differently
  // Look for the message output item
  if (data.output_text) {
    return data.output_text;
  }
  
  // Or extract from output array
  if (Array.isArray(data.output)) {
    const messageItem = data.output.find(item => item.type === 'message');
    if (messageItem?.content?.[0]?.text) {
      return messageItem.content[0].text;
    }
  }
  
  throw new Error('Unexpected response format from OpenAI Responses API');
}

// Call Gemini API
async function callGemini(modelConfig, messages, apiKey, options = {}) {
  const { webSearch } = options;
  
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
  
  const requestBody = {
    contents,
    systemInstruction: {
      parts: [{ text: systemContext }]
    },
    generationConfig: {
      maxOutputTokens: modelConfig.maxTokens
    }
  };
  
  // Add Google Search grounding if web search is enabled
  if (webSearch) {
    requestBody.tools = [
      { google_search: {} }
    ];
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Gemini API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Track token usage (Gemini returns usage in usageMetadata)
  if (data.usageMetadata) {
    trackUsage({
      provider: 'gemini',
      model: modelConfig.model,
      feature: options.feature || 'chat',
      inputTokens: data.usageMetadata.promptTokenCount || 0,
      outputTokens: data.usageMetadata.candidatesTokenCount || 0
    });
  }
  
  return data.candidates[0].content.parts[0].text;
}

/**
 * Main chat function
 * @param {string} modelId - Model identifier (e.g., 'anthropic:claude-sonnet-4-5')
 * @param {Array} messages - Array of message objects with role and content
 * @param {boolean} includeContext - Whether to include resume context
 * @param {Object} options - Additional options
 * @param {string} options.reasoningEffort - Reasoning effort level: 'none', 'low', 'medium', 'high'
 * @param {boolean} options.webSearch - Whether to enable web search (Gemini only)
 * @returns {Promise<string>} AI response
 */
export async function chat(modelId, messages, includeContext = true, options = {}) {
  // Validate and potentially migrate the model ID
  const validModelId = validateModelId(modelId);
  const modelConfig = MODELS[validModelId];
  if (!modelConfig) {
    throw new Error(`No valid model available. Please configure an API key in settings.`);
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
  
  // Call the appropriate API with options
  switch (modelConfig.provider) {
    case 'anthropic':
      return callAnthropic(modelConfig, processedMessages, apiKey, options);
    case 'openai':
      return callOpenAI(modelConfig, processedMessages, apiKey, options);
    case 'gemini':
      return callGemini(modelConfig, processedMessages, apiKey, options);
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
  
  return chat(modelId, messages, true, { feature: 'generate' });
}

export async function generateBullets(modelId, context, count = 3) {
  const messages = [{
    role: 'user',
    content: `Based on the resume and this context: "${context}", generate ${count} impactful bullet points. Format as a numbered list.`
  }];
  
  return chat(modelId, messages, true, { feature: 'generate' });
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
  
  return chat(modelId, messages, true, { feature: 'feedback' });
}

export async function improveSummary(modelId) {
  const messages = [{
    role: 'user',
    content: `Please rewrite my resume summary to be more compelling and impactful. Make it concise but powerful, highlighting key strengths and value proposition. Provide only the improved summary text.`
  }];
  
  return chat(modelId, messages, true, { feature: 'generate' });
}

/**
 * Generate structured resume changes that can be displayed in a diff view
 * @param {string} modelId - Model to use
 * @param {string} instruction - User's instruction for what to change
 * @param {string} targetPath - Optional specific path to target (e.g., "summary", "experience[0]")
 * @param {Object} additionalContext - Optional additional context like job descriptions
 * @param {string} featureName - Optional feature name for tracking (defaults to 'generate')
 * @returns {Object} Object with changes and explanation
 */
export async function generateResumeChanges(modelId, instruction, targetPath = null, additionalContext = null, featureName = 'generate') {
  // Validate and potentially migrate the model ID
  const validModelId = validateModelId(modelId);
  const modelConfig = MODELS[validModelId];
  if (!modelConfig) {
    throw new Error(`No valid model available. Please configure an API key in settings.`);
  }
  
  const apiKey = getApiKey(modelConfig.provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${modelConfig.provider}. Please add your API key in settings.`);
  }
  
  const resumeData = store.getData();
  if (!resumeData) {
    throw new Error('No resume data available');
  }
  
  // Include user profile context for better suggestions
  const userProfileContext = getUserProfileContext();
  
  // Build the prompt
  let prompt = '';
  
  // Add user profile context if available
  if (userProfileContext) {
    prompt += `${userProfileContext}\n`;
  }
  
  prompt += `Here is the current resume data as JSON:\n\n${JSON.stringify(resumeData, null, 2)}\n\n`;
  
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
  const featureOptions = { feature: featureName };
  
  switch (modelConfig.provider) {
    case 'anthropic':
      response = await callAnthropicWithSystem(modelConfig, messages, apiKey, CHANGE_GENERATION_PROMPT, featureOptions);
      break;
    case 'openai':
      response = await callOpenAIWithSystem(modelConfig, messages, apiKey, CHANGE_GENERATION_PROMPT, featureOptions);
      break;
    case 'gemini':
      response = await callGeminiWithSystem(modelConfig, messages, apiKey, CHANGE_GENERATION_PROMPT, featureOptions);
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
async function callAnthropicWithSystem(modelConfig, messages, apiKey, systemPrompt, options = {}) {
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
  
  // Track token usage
  if (data.usage) {
    trackUsage({
      provider: 'anthropic',
      model: modelConfig.model,
      feature: options.feature || 'chat',
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
      cacheRead: data.usage.cache_read_input_tokens || 0,
      cacheCreation: data.usage.cache_creation_input_tokens || 0
    });
  }
  
  return data.content[0].text;
}

async function callOpenAIWithSystem(modelConfig, messages, apiKey, systemPrompt, options = {}) {
  // GPT-5.x models require the Responses API (not Chat Completions)
  const isGpt5 = modelConfig.model.startsWith('gpt-5');
  if (isGpt5) {
    return callOpenAIResponsesWithSystem(modelConfig, messages, apiKey, systemPrompt, options);
  }
  
  // Check if this is an o1 reasoning model (uses 'developer' role instead of 'system')
  const isO1Model = modelConfig.model.startsWith('o1');
  
  // Build messages array with appropriate role for system instructions
  const apiMessages = isO1Model
    ? [
        { role: 'developer', content: systemPrompt },
        ...messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      ]
    : [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      ];
  
  const response = await fetch(ENDPOINTS.openai, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelConfig.model,
      max_completion_tokens: modelConfig.maxTokens,
      messages: apiMessages
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Track token usage
  if (data.usage) {
    trackUsage({
      provider: 'openai',
      model: modelConfig.model,
      feature: options.feature || 'chat',
      inputTokens: data.usage.prompt_tokens || 0,
      outputTokens: data.usage.completion_tokens || 0
    });
  }
  
  return data.choices[0].message.content;
}

// Call OpenAI Responses API with custom system prompt (for GPT-5.x)
async function callOpenAIResponsesWithSystem(modelConfig, messages, apiKey, systemPrompt, options = {}) {
  // Build input from messages
  const input = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content
  }));
  
  // Add system prompt context to first user message
  if (input.length > 0 && input[0].role === 'user') {
    input[0].content = `${systemPrompt}\n\n${input[0].content}`;
  }
  
  const requestBody = {
    model: modelConfig.model,
    input: input
  };
  
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Track token usage
  if (data.usage) {
    trackUsage({
      provider: 'openai',
      model: modelConfig.model,
      feature: options.feature || 'chat',
      inputTokens: data.usage.input_tokens || data.usage.prompt_tokens || 0,
      outputTokens: data.usage.output_tokens || data.usage.completion_tokens || 0
    });
  }
  
  // Responses API returns output differently
  if (data.output_text) {
    return data.output_text;
  }
  
  // Or extract from output array
  if (Array.isArray(data.output)) {
    const messageItem = data.output.find(item => item.type === 'message');
    if (messageItem?.content?.[0]?.text) {
      return messageItem.content[0].text;
    }
  }
  
  throw new Error('Unexpected response format from OpenAI Responses API');
}

async function callGeminiWithSystem(modelConfig, messages, apiKey, systemPrompt, options = {}) {
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
  
  // Track token usage (Gemini returns usage in usageMetadata)
  if (data.usageMetadata) {
    trackUsage({
      provider: 'gemini',
      model: modelConfig.model,
      feature: options.feature || 'chat',
      inputTokens: data.usageMetadata.promptTokenCount || 0,
      outputTokens: data.usageMetadata.candidatesTokenCount || 0
    });
  }
  
  return data.candidates[0].content.parts[0].text;
}

/**
 * Analyze resume against job descriptions
 * @param {string} modelId - Model to use
 * @param {Array} jobDescriptions - Array of job description objects
 * @returns {Object} Analysis results
 */
export async function analyzeAgainstJobs(modelId, jobDescriptions) {
  // Validate and potentially migrate the model ID
  const validModelId = validateModelId(modelId);
  const modelConfig = MODELS[validModelId];
  if (!modelConfig) {
    throw new Error(`No valid model available. Please configure an API key in settings.`);
  }
  
  const apiKey = getApiKey(modelConfig.provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${modelConfig.provider}. Please add your API key in settings.`);
  }
  
  const resumeData = store.getData();
  if (!resumeData) {
    throw new Error('No resume data available');
  }
  
  // Include user profile context for better analysis
  const userProfileContext = getUserProfileContext();
  
  let prompt = `Analyze this resume against the target job description(s).\n\n`;
  
  // Add user profile context if available
  if (userProfileContext) {
    prompt += `${userProfileContext}\n`;
  }
  
  prompt += `Resume:\n${JSON.stringify(resumeData, null, 2)}\n\n`;
  prompt += `Job Descriptions:\n`;
  
  for (const jd of jobDescriptions) {
    prompt += `\n--- ${jd.title} at ${jd.company} ---\n${jd.description}\n`;
  }
  
  prompt += `\nProvide your analysis as a JSON object. No markdown, just raw JSON.`;
  
  const messages = [{ role: 'user', content: prompt }];
  const featureOptions = { feature: 'analyze' };
  
  let response;
  switch (modelConfig.provider) {
    case 'anthropic':
      response = await callAnthropicWithSystem(modelConfig, messages, apiKey, JOB_ANALYSIS_PROMPT, featureOptions);
      break;
    case 'openai':
      response = await callOpenAIWithSystem(modelConfig, messages, apiKey, JOB_ANALYSIS_PROMPT, featureOptions);
      break;
    case 'gemini':
      response = await callGeminiWithSystem(modelConfig, messages, apiKey, JOB_ANALYSIS_PROMPT, featureOptions);
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
  }, 'tailor');
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

/**
 * Conduct a profile interview chat
 * @param {string} modelId - Model to use
 * @param {Array} conversationHistory - Previous messages in the interview
 * @returns {Promise<string>} AI response
 */
export async function profileInterviewChat(modelId, conversationHistory) {
  const validModelId = validateModelId(modelId);
  const modelConfig = MODELS[validModelId];
  if (!modelConfig) {
    throw new Error(`No valid model available. Please configure an API key in settings.`);
  }
  
  const apiKey = getApiKey(modelConfig.provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${modelConfig.provider}. Please add your API key in settings.`);
  }
  
  const messages = conversationHistory.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content
  }));
  const featureOptions = { feature: 'profile' };
  
  switch (modelConfig.provider) {
    case 'anthropic':
      return callAnthropicWithSystem(modelConfig, messages, apiKey, PROFILE_INTERVIEW_PROMPT, featureOptions);
    case 'openai':
      return callOpenAIWithSystem(modelConfig, messages, apiKey, PROFILE_INTERVIEW_PROMPT, featureOptions);
    case 'gemini':
      return callGeminiWithSystem(modelConfig, messages, apiKey, PROFILE_INTERVIEW_PROMPT, featureOptions);
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`);
  }
}

/**
 * Extract profile data from interview conversation
 * @param {string} modelId - Model to use
 * @param {Array} conversationHistory - The interview conversation
 * @returns {Promise<Object>} Extracted profile data
 */
export async function extractProfileFromInterview(modelId, conversationHistory) {
  const validModelId = validateModelId(modelId);
  const modelConfig = MODELS[validModelId];
  if (!modelConfig) {
    throw new Error(`No valid model available. Please configure an API key in settings.`);
  }
  
  const apiKey = getApiKey(modelConfig.provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${modelConfig.provider}. Please add your API key in settings.`);
  }
  
  // Format conversation for extraction
  let conversationText = 'Interview Conversation:\n\n';
  for (const msg of conversationHistory) {
    const role = msg.role === 'user' ? 'User' : 'Interviewer';
    conversationText += `${role}: ${msg.content}\n\n`;
  }
  
  const messages = [{ role: 'user', content: conversationText }];
  const featureOptions = { feature: 'profile' };
  
  let response;
  switch (modelConfig.provider) {
    case 'anthropic':
      response = await callAnthropicWithSystem(modelConfig, messages, apiKey, PROFILE_EXTRACTION_PROMPT, featureOptions);
      break;
    case 'openai':
      response = await callOpenAIWithSystem(modelConfig, messages, apiKey, PROFILE_EXTRACTION_PROMPT, featureOptions);
      break;
    case 'gemini':
      response = await callGeminiWithSystem(modelConfig, messages, apiKey, PROFILE_EXTRACTION_PROMPT, featureOptions);
      break;
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`);
  }
  
  try {
    let jsonStr = response.trim();
    // Try to extract JSON from markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }
    
    // Also try to find JSON object if it's mixed with text
    const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      jsonStr = jsonObjectMatch[0];
    }
    
    const parsed = JSON.parse(jsonStr);
    console.log('[ProfileExtraction] Successfully parsed profile:', parsed);
    
    // Normalize the parsed data to ensure correct field names
    const normalized = {
      personalSummary: parsed.personalSummary || parsed.personal_summary || parsed.summary || '',
      careerGoals: parsed.careerGoals || parsed.career_goals || parsed.goals || '',
      workExperience: parsed.workExperience || parsed.work_experience || parsed.experience || [],
      skills: parsed.skills || [],
      education: parsed.education || [],
      projects: parsed.projects || [],
      certifications: parsed.certifications || [],
      achievements: parsed.achievements || [],
      industryKnowledge: parsed.industryKnowledge || parsed.industry_knowledge || parsed.industry || '',
      preferences: parsed.preferences || ''
    };
    
    console.log('[ProfileExtraction] Normalized profile:', normalized);
    return normalized;
  } catch (e) {
    console.error('Failed to parse profile extraction response:', response);
    console.error('Parse error:', e);
    throw new Error('Failed to extract profile data. Please try again.');
  }
}

/**
 * Save extracted profile data (merges with existing)
 * @param {Object} extractedProfile - Profile data extracted from interview
 */
export function saveExtractedProfile(extractedProfile) {
  console.log('[Profile] Extracted profile to save:', extractedProfile);
  
  const existingProfile = getUserProfile() || {};
  console.log('[Profile] Existing profile:', existingProfile);
  
  // Merge extracted data with existing profile
  const mergedProfile = { ...existingProfile };
  
  // For text fields, prefer new content if it exists
  const textFields = ['personalSummary', 'careerGoals', 'preferences', 'industryKnowledge'];
  for (const field of textFields) {
    if (extractedProfile[field] && extractedProfile[field].trim()) {
      mergedProfile[field] = extractedProfile[field];
    }
  }
  
  // For array fields, merge (add new items)
  const arrayFields = ['workExperience', 'skills', 'education', 'projects', 'certifications', 'achievements', 'customSections'];
  for (const field of arrayFields) {
    if (extractedProfile[field] && extractedProfile[field].length > 0) {
      // Simple merge: add new items to existing
      mergedProfile[field] = [
        ...(existingProfile[field] || []),
        ...extractedProfile[field]
      ];
    }
  }
  
  console.log('[Profile] Merged profile to save:', mergedProfile);
  saveUserProfile(mergedProfile);
  
  // Verify the save worked
  const savedProfile = getUserProfile();
  console.log('[Profile] Verified saved profile:', savedProfile);
  
  return mergedProfile;
}
