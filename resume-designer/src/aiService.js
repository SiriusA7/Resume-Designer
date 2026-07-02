/**
 * AI Service
 * Unified interface to AI models via OpenRouter (single aggregate provider).
 */

import { getSettings, saveSettings, getUserProfile, saveUserProfile } from './persistence.js';
import { store } from './store.js';
import { getActiveJobDescriptions } from './jobDescriptions.js';
import { trackUsage } from './tokenTrackingService.js';
import { createStreamAccumulator } from './aiStream.js';
import { appStorage } from './appStorage.js';

// OpenRouter — a single OpenAI-compatible endpoint fronting every provider.
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Optional attribution headers (OpenRouter app leaderboard); harmless if unused.
const OPENROUTER_REFERER = 'https://github.com/ashproto/Resume-Designer';
const OPENROUTER_TITLE = 'Resume Designer';

// Curated model catalog, keyed by OpenRouter slug. The slug is the SINGLE
// canonical identifier: it is the storage key, the dropdown value, AND the
// `model` field sent on the wire. Users may also type any other OpenRouter
// slug via the custom-model field — see validateModelId().
// Slugs verified against GET https://openrouter.ai/api/v1/models (catalog
// drifts; re-verify when refreshing this list).
// This built-in shortlist is the "featured" set shown grouped in the picker. It
// is best-effort current (verified against GET .../v1/models on 2026-05-31; the
// catalog drifts — re-verify when refreshing). The live cached catalog
// (fetchModelCatalog) is the runtime source of truth for reasoning support, and
// users can pick any other slug via the custom-model field.
const MODELS = {
  'anthropic/claude-opus-4.8':     { label: 'Claude Opus 4.8',    group: 'Anthropic', maxTokens: 8192 },
  'anthropic/claude-sonnet-4.6':   { label: 'Claude Sonnet 4.6',  group: 'Anthropic', maxTokens: 8192 },
  'anthropic/claude-haiku-4.5':    { label: 'Claude Haiku 4.5',   group: 'Anthropic', maxTokens: 4096 },
  'openai/gpt-5.5':                { label: 'GPT-5.5',            group: 'OpenAI',    maxTokens: 8192 },
  'openai/gpt-5.5-pro':            { label: 'GPT-5.5 Pro',        group: 'OpenAI',    maxTokens: 16384 },
  'openai/gpt-5-mini':             { label: 'GPT-5 Mini',         group: 'OpenAI',    maxTokens: 8192 },
  'google/gemini-3.1-pro-preview': { label: 'Gemini 3 Pro',       group: 'Google',    maxTokens: 8192 },
  'google/gemini-3.5-flash':       { label: 'Gemini 3.5 Flash',   group: 'Google',    maxTokens: 8192 },
  'google/gemini-2.5-pro':         { label: 'Gemini 2.5 Pro',     group: 'Google',    maxTokens: 8192 },
  'x-ai/grok-4.3':                 { label: 'Grok 4.3',           group: 'xAI',       maxTokens: 8192 },
  'deepseek/deepseek-v4-pro':      { label: 'DeepSeek V4 Pro',    group: 'DeepSeek',  maxTokens: 8192 },
  'mistralai/mistral-medium-3-5':  { label: 'Mistral Medium 3.5', group: 'Mistral',  maxTokens: 8192 }
};

// Default model used when nothing valid is selected.
const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-4.6';

// Cross-provider fallback chain for OpenRouter's `models` array (used only when
// the autoFallback setting is on). Cross-provider on purpose: if one provider
// is down/rate-limited, retrying the SAME provider's model wouldn't help.
const FALLBACK_CHAIN = ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.5', 'google/gemini-3.1-pro-preview'];

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

// Résumé text fields are rendered with light markdown — the renderer converts
// **text** → bold and _text_ → italic before display AND before PDF capture, so no
// literal markers ever reach the output (ATS sees clean bold text, not asterisks).
// Generators share this guidance so they can spotlight high-signal phrases without
// over-formatting.
const EMPHASIS_GUIDANCE = `EMPHASIS — inside prose fields only (summary, highlights, experience bullets, and section content) you may spotlight the single most important phrase using markdown: **double asterisks** for bold, _underscores_ for italic. Apply it strategically and SPARINGLY — at most one emphasis per bullet, and never wrap a whole sentence. Prefer bolding a quantified result (e.g. **40% faster**) or a key keyword from the job description; reserve italic for a secondary qualifier. Do NOT emphasize names, titles, companies, dates, skills, tools, or contact fields. The markers are literal characters inside the JSON string values, so the response itself stays pure JSON (no code fences).`;

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
1. ONLY output valid JSON - no code fences, no explanation outside the JSON
2. Include all fields that should be changed
3. For array items, use numeric indices like experience[0].bullets[1]
4. Keep unchanged fields out of the response
5. The explanation field should be inside the JSON

${EMPHASIS_GUIDANCE}`;

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

// Get the OpenRouter API key (one aggregate provider now).
function getApiKey() {
  return getSettings().openrouterKey || '';
}

// Whether the app has an OpenRouter key configured.
export function isConfigured() {
  return getApiKey().length > 0;
}

// Back-compat shim: getConfiguredProviders() is still used for UI gating
// (callers only check .length). One aggregate provider → ['openrouter'] or [].
export function getConfiguredProviders() {
  return isConfigured() ? ['openrouter'] : [];
}

// Default model when nothing valid is selected.
export function getDefaultModelId() {
  return isConfigured() ? DEFAULT_MODEL_ID : null;
}

// Legacy provider:model IDs → OpenRouter slugs. One-time migration of a
// `defaultModel` saved by the pre-OpenRouter build (see persistence.js too).
const LEGACY_MODEL_MAP = {
  'anthropic:claude-opus-4-5': 'anthropic/claude-opus-4.8',
  'anthropic:claude-sonnet-4-5': 'anthropic/claude-sonnet-4.6',
  'anthropic:claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'openai:gpt-5.2': 'openai/gpt-5.5',
  'openai:gpt-5.2-pro': 'openai/gpt-5.5-pro',
  'openai:gpt-4o': 'openai/gpt-5-mini',
  'openai:gpt-4o-mini': 'openai/gpt-5-mini',
  'gemini:gemini-3-pro': 'google/gemini-3.1-pro-preview',
  'gemini:gemini-3-flash': 'google/gemini-3.5-flash',
  'gemini:gemini-2.0-flash': 'google/gemini-3.5-flash',
  'gemini:gemini-1.5-pro': 'google/gemini-2.5-pro'
};

// A model slug is "safe" when it contains none of the characters that real
// OpenRouter slugs never use but that would be dangerous if the slug were ever
// rendered as HTML (e.g. in the model dropdown label). Deny-list, not allow-list,
// so exotic-but-valid slugs (`:free`, `:nitro`, dotted/dated names, …) are never
// wrongly rejected. Belt-and-suspenders behind escapeHtml at the render sites.
export function isSafeModelSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 &&
    !/[<>"'`\x00-\x1f\s]/.test(slug);
}

// Validate/normalize a model ID. Curated slugs pass through; any well-formed,
// safe custom OpenRouter slug (contains "/") is allowed; legacy colon IDs
// migrate; unknown/empty/unsafe falls back to the default.
export function validateModelId(modelId) {
  if (modelId && MODELS[modelId]) return modelId;
  if (typeof modelId === 'string') {
    // Custom OpenRouter slug — accept only when it has no HTML-dangerous chars,
    // so a poisoned `defaultModel` (typed, or restored from an imported backup)
    // is normalized away here before it can reach any renderer.
    if (modelId.includes('/')) {
      return isSafeModelSlug(modelId) ? modelId : getDefaultModelId();
    }
    if (LEGACY_MODEL_MAP[modelId]) return LEGACY_MODEL_MAP[modelId];
  }
  return getDefaultModelId();
}

// Get list of available (curated) model IDs.
export function getAvailableModelIds() {
  return Object.keys(MODELS);
}

// ---- Live model catalog (OpenRouter GET /models) ----------------------------
// Public endpoint (no auth). Cached in-memory + appStorage (reduced fields
// only, for quota) with a 24h TTL. Powers per-model reasoning detection and
// custom-slug awareness. NEVER throws: the picker must keep working offline from
// the built-in shortlist + the user's cached custom slugs.
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const CATALOG_STORAGE_KEY = 'resume-designer-model-catalog';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
let catalogMemo = null;
let catalogInflight = null;

function readCatalogCache() {
  if (catalogMemo) return catalogMemo;
  try {
    const parsed = JSON.parse(appStorage.getItem(CATALOG_STORAGE_KEY) || 'null');
    if (parsed && parsed.models && typeof parsed.fetchedAt === 'number') {
      catalogMemo = parsed;
      return parsed;
    }
  } catch (_) { /* ignore corrupt cache */ }
  return null;
}

function catalogIsFresh(c) {
  return !!c && (Date.now() - c.fetchedAt) < CATALOG_TTL_MS;
}

// Fetch + cache the catalog. Returns the (possibly stale) cache on failure.
export async function fetchModelCatalog(force = false) {
  const cached = readCatalogCache();
  if (!force && catalogIsFresh(cached)) return cached;
  if (catalogInflight) return catalogInflight;
  catalogInflight = (async () => {
    try {
      const res = await fetch(MODELS_ENDPOINT, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      const models = {};
      for (const m of (data && data.data) || []) {
        if (!m || typeof m.id !== 'string') continue;
        const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
        models[m.id] = { reasoning: params.includes('reasoning') };
      }
      const fresh = { fetchedAt: Date.now(), models };
      catalogMemo = fresh;
      try { appStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(fresh)); } catch (_) { /* quota */ }
      return fresh;
    } catch (e) {
      console.warn('[aiService] model catalog fetch failed:', (e && e.message) || e);
      return cached || null;
    } finally {
      catalogInflight = null;
    }
  })();
  return catalogInflight;
}

// Does this model support reasoning/thinking? Consults the cached catalog's
// supported_parameters. Curated models are all reasoning-capable. Unknown or
// offline → TRUE (optimistic): OpenRouter ignores the `reasoning` field for
// models that don't support it, so a false-positive is harmless; a false-negative
// would needlessly disable the control before the catalog has loaded.
export function modelSupportsReasoning(slug) {
  if (!slug) return true;
  const entry = readCatalogCache()?.models?.[slug];
  if (entry) return !!entry.reasoning;
  if (MODELS[slug]) return true;
  return true;
}

// ---- User-added custom model slugs ------------------------------------------
// Persisted in settings.customModels (most-recent first) so a working custom
// slug reappears in the picker without re-typing. Curated dupes + unsafe values
// are filtered out on read.
export function getCustomModels() {
  const list = getSettings().customModels;
  if (!Array.isArray(list)) return [];
  return list.filter(s => typeof s === 'string' && isSafeModelSlug(s) && !MODELS[s]);
}

export function addCustomModel(slug) {
  if (!isSafeModelSlug(slug) || !slug.includes('/') || MODELS[slug]) return false;
  const list = getCustomModels();
  // Already the most-recent entry — no change, so skip the write (and the
  // SETTINGS_UPDATED_EVENT it would fire). Without this, every message sent with
  // an already-cached custom model would re-render the chat panel.
  if (list[0] === slug) return false;
  const next = [slug, ...list.filter(s => s !== slug)].slice(0, 20);
  saveSettings({ customModels: next });
  return true;
}

export function removeCustomModel(slug) {
  const list = getCustomModels();
  if (!list.includes(slug)) return false;
  saveSettings({ customModels: list.filter(s => s !== slug) });
  return true;
}

// Cross-provider fallback models for a primary (used only when autoFallback on).
function getFallbackModels(modelId) {
  const primaryGroup = MODELS[modelId]?.group;
  return FALLBACK_CHAIN
    .filter(slug => slug !== modelId && MODELS[slug]?.group !== primaryGroup)
    .slice(0, 2);
}

// Check if user profile has meaningful content
function isProfileEmpty(profile) {
  if (!profile) return true;
  
  // Check contact info fields
  if (profile.contactInfo) {
    const contactFields = ['fullName', 'email', 'phone', 'location', 'linkedin', 'portfolio', 'github', 'twitter', 'instagram'];
    for (const field of contactFields) {
      if (profile.contactInfo[field] && profile.contactInfo[field].trim().length > 0) return false;
    }
  }
  
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

/**
 * Check if user profile has enough data to generate a resume
 * @returns {boolean} True if profile has meaningful data
 */
export function checkProfileHasData() {
  const profile = getUserProfile();
  return !isProfileEmpty(profile);
}

/**
 * Generate a complete resume from user profile, tailored for a specific job
 * @param {string} modelId - The AI model to use
 * @param {Object} jobDescription - The job description object { title, company, description }
 * @param {Object} options - Additional options
 * @param {string} options.reasoningEffort - Reasoning effort level: 'none', 'low', 'medium', 'high'
 * @returns {Object} Generated resume data
 */
export async function generateResumeFromProfileForJob(modelId, jobDescription, options = {}) {
  const profile = getUserProfile();
  
  if (!profile || isProfileEmpty(profile)) {
    throw new Error('User profile is empty. Please fill out your profile first.');
  }
  
  const validModelId = validateModelId(modelId);
  if (!isConfigured()) {
    throw new Error('No OpenRouter API key configured. Please add your key in settings.');
  }
  
  // Build comprehensive profile context
  let profileContext = `## User Profile Information\n\n`;
  
  // Add contact information if present
  if (profile.contactInfo) {
    const contact = profile.contactInfo;
    profileContext += `### Contact Information\n`;
    if (contact.fullName) profileContext += `- **Full Name:** ${contact.fullName}\n`;
    if (contact.email) profileContext += `- **Email:** ${contact.email}\n`;
    if (contact.phone) profileContext += `- **Phone:** ${contact.phone}\n`;
    if (contact.location) profileContext += `- **Location:** ${contact.location}\n`;
    if (contact.linkedin) profileContext += `- **LinkedIn:** ${contact.linkedin}\n`;
    if (contact.portfolio) profileContext += `- **Portfolio/Website:** ${contact.portfolio}\n`;
    if (contact.github) profileContext += `- **GitHub:** ${contact.github}\n`;
    if (contact.twitter) profileContext += `- **Twitter:** ${contact.twitter}\n`;
    if (contact.instagram) profileContext += `- **Instagram:** ${contact.instagram}\n`;
    profileContext += '\n';
  }
  
  if (profile.personalSummary) {
    profileContext += `### Personal Summary\n${profile.personalSummary}\n\n`;
  }
  
  if (profile.careerGoals) {
    profileContext += `### Career Goals\n${profile.careerGoals}\n\n`;
  }
  
  if (profile.workExperience && profile.workExperience.length > 0) {
    profileContext += `### Work Experience\n`;
    for (const exp of profile.workExperience) {
      profileContext += `\n**${exp.title || 'Position'}** at **${exp.company || 'Company'}**`;
      if (exp.dates) profileContext += ` (${exp.dates})`;
      profileContext += `\n`;
      if (exp.details) profileContext += `${exp.details}\n`;
    }
    profileContext += '\n';
  }
  
  if (profile.skills && profile.skills.length > 0) {
    profileContext += `### Skills\n`;
    for (const skill of profile.skills) {
      let skillLine = `- ${skill.name || skill}`;
      if (skill.proficiency) skillLine += ` (${skill.proficiency})`;
      if (skill.years) skillLine += ` - ${skill.years} years`;
      profileContext += skillLine + '\n';
    }
    profileContext += '\n';
  }
  
  if (profile.education && profile.education.length > 0) {
    profileContext += `### Education\n`;
    for (const edu of profile.education) {
      profileContext += `- **${edu.degree || 'Degree'}** from ${edu.institution || 'Institution'}`;
      if (edu.dates) profileContext += ` (${edu.dates})`;
      if (edu.details) profileContext += `\n  ${edu.details}`;
      profileContext += '\n';
    }
    profileContext += '\n';
  }
  
  if (profile.projects && profile.projects.length > 0) {
    profileContext += `### Projects\n`;
    for (const proj of profile.projects) {
      profileContext += `- **${proj.name || 'Project'}**`;
      if (proj.url) profileContext += ` (${proj.url})`;
      if (proj.description) profileContext += `: ${proj.description}`;
      profileContext += '\n';
    }
    profileContext += '\n';
  }
  
  if (profile.certifications && profile.certifications.length > 0) {
    profileContext += `### Certifications\n`;
    for (const cert of profile.certifications) {
      profileContext += `- ${cert.name || cert}`;
      if (cert.year) profileContext += ` (${cert.year})`;
      profileContext += '\n';
    }
    profileContext += '\n';
  }
  
  if (profile.achievements && profile.achievements.length > 0) {
    profileContext += `### Achievements\n`;
    for (const ach of profile.achievements) {
      profileContext += `- ${ach.description || ach}\n`;
    }
    profileContext += '\n';
  }
  
  if (profile.industryKnowledge) {
    profileContext += `### Industry Knowledge\n${profile.industryKnowledge}\n\n`;
  }
  
  if (profile.preferences) {
    profileContext += `### Preferences\n${profile.preferences}\n\n`;
  }
  
  // Build the prompt
  const prompt = `You are an expert resume consultant and ATS optimization specialist. Your task is to create the BEST possible resume from the user's profile data, specifically tailored for a target job.

${profileContext}

## Target Job

**Position:** ${jobDescription.title || 'Not specified'}
**Company:** ${jobDescription.company || 'Not specified'}

**Job Description:**
${jobDescription.description}

## Your Task

Create a complete, ATS-optimized resume that:
1. Highlights the most relevant experience and skills for this specific job
2. Uses keywords and phrases from the job description naturally
3. Orders experience by relevance to the target role (most relevant first), and
   ALSO provides machine-readable startDate/endDate per role so the app can
   re-sort chronologically
4. Writes a compelling professional summary tailored to this position
5. Creates impactful bullet points with quantifiable achievements where possible
6. Includes 3-4 highlights that are DISTINCT, career-level achievements — not
   restatements of the experience bullets
7. Separates concrete tools/software from competency skills (see the fields below)

Return ONLY a valid JSON object (no code fences, no prose outside the JSON) in this exact format:
{
  "name": "Full Name from profile",
  "tagline": "Professional title tailored to target job",
  "email": "email from profile if available",
  "phone": "phone from profile if available",
  "location": "location from profile if available",
  "linkedin": "linkedin url if available",
  "portfolio": "portfolio url if available",
  "summary": "2-3 sentence compelling summary tailored for this specific job",
  "highlights": [
    "Career-level achievement, distinct from the experience bullets below",
    "Another high-level qualification matching the job (not repeated below)",
    "Quantifiable, summary-level achievement relevant to the role"
  ],
  "skills": ["competency1", "competency2", "... (at most 12, most relevant only)"],
  "tools": ["Concrete tool/software/platform e.g. Figma", "Git", "Docker"],
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "location": "City, State",
      "startDate": "YYYY-MM (machine-readable; YYYY ok if month unknown)",
      "endDate": "YYYY-MM or "Present" (machine-readable)",
      "dates": "Human-readable range shown on the resume, e.g. Jan 2022 - Jun 2024",
      "bullets": [
        "Achievement bullet with quantifiable results relevant to target job",
        "Another impactful bullet highlighting relevant skills",
        "More achievements tailored to the job requirements"
      ]
    }
  ],
  "education": [
    {
      "degree": "Degree Name",
      "school": "School Name",
      "year": "Year"
    }
  ],
  "certifications": ["Relevant certification 1", "Relevant certification 2"]
}

IMPORTANT:
- Only include sections that have relevant content from the profile
- Order experience by relevance (most relevant first); ALWAYS include
  machine-readable startDate/endDate so the app can offer a chronological view
- Put concrete tools/software/platforms (e.g. Figma, Git, Docker, Excel) in
  "tools"; keep "skills" for competencies. Do NOT duplicate an item across both.
- Limit "highlights" to 3-4 entries, each a DISTINCT career-level achievement,
  not a copy of an experience bullet
- Select at most 12 of the most relevant skills (quality over quantity)
- Use action verbs and quantify achievements where possible
- Include keywords from the job description naturally
- Make the summary compelling and specific to this role

${EMPHASIS_GUIDANCE}`;

  const messages = [{ role: 'user', content: prompt }];
  
  const response = await callOpenRouter(validModelId, messages, {
    feature: 'generate-from-profile',
    reasoningEffort: options.reasoningEffort,
    hooks: options.hooks,
    signal: options.signal,
  });
  
  // Parse the JSON response
  try {
    let jsonStr = response.trim();
    // Remove markdown code blocks if present
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }
    
    const resume = JSON.parse(jsonStr);
    console.log('[AI Service] Generated resume from profile:', resume);
    return resume;
  } catch {
    console.error('Failed to parse AI response as JSON:', response);
    throw new Error('AI response was not valid JSON. Please try again.');
  }
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
  
  // Add contact information if present
  if (profile.contactInfo) {
    const contact = profile.contactInfo;
    if (contact.fullName || contact.email || contact.phone || contact.location) {
      context += `### Contact Information\n`;
      if (contact.fullName) context += `- **Name:** ${contact.fullName}\n`;
      if (contact.email) context += `- **Email:** ${contact.email}\n`;
      if (contact.phone) context += `- **Phone:** ${contact.phone}\n`;
      if (contact.location) context += `- **Location:** ${contact.location}\n`;
      if (contact.linkedin) context += `- **LinkedIn:** ${contact.linkedin}\n`;
      if (contact.portfolio) context += `- **Portfolio:** ${contact.portfolio}\n`;
      if (contact.github) context += `- **GitHub:** ${contact.github}\n`;
      if (contact.twitter) context += `- **Twitter:** ${contact.twitter}\n`;
      if (contact.instagram) context += `- **Instagram:** ${contact.instagram}\n`;
      context += '\n';
    }
  }
  
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
  
  // Concrete tools/software live in a separate top-level field (kept out of the
  // Skills section since #3), so serialize them explicitly — otherwise follow-up
  // AI chat and tailoring would no longer see tools like Figma/Docker. (PR#13)
  if (data.tools) {
    const toolsList = (Array.isArray(data.tools) ? data.tools : String(data.tools).split('•'))
      .map(t => String(t).trim())
      .filter(Boolean);
    if (toolsList.length > 0) {
      context += `Tools:\n${toolsList.join(', ')}\n\n`;
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

// Streaming OpenRouter call path. Drives the pure accumulator and invokes live
// hooks (onReasoning / onContent / onAnnotations) as deltas arrive. Returns the
// final structured result. Side effects (addCustomModel, trackUsage) fire once.
async function streamOpenRouter(modelId, messages, options = {}, hooks = {}) {
  const { systemPrompt = SYSTEM_PROMPT, reasoningEffort, webSearch, feature, signal } = options;

  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No OpenRouter API key configured. Please add your key in settings.');

  const cfg = MODELS[modelId];
  const reasoningOn = reasoningEffort && reasoningEffort !== 'none' && modelSupportsReasoning(modelId);

  const apiMessages = [];
  if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    const msg = { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
    // Anthropic thinking continuity: replay prior reasoning_details unmodified.
    if (msg.role === 'assistant' && Array.isArray(m.reasoningDetails) && m.reasoningDetails.length) {
      msg.reasoning_details = m.reasoningDetails;
    }
    apiMessages.push(msg);
  }

  const requestBody = {
    model: modelId,
    messages: apiMessages,
    // Reasoning competes with the completion budget; give the answer headroom
    // when thinking is on (OpenRouter clamps to the model's real max).
    max_tokens: reasoningOn ? Math.max(cfg?.maxTokens || 8192, 16000) : (cfg?.maxTokens || 8192),
    stream: true,
    usage: { include: true },
  };
  if (getSettings().autoFallback) {
    const fallbacks = getFallbackModels(modelId);
    if (fallbacks.length) requestBody.models = [modelId, ...fallbacks];
  }
  if (reasoningOn) requestBody.reasoning = { effort: reasoningEffort };
  if (webSearch) requestBody.tools = [{ type: 'openrouter:web_search' }];

  let response;
  try {
    response = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': OPENROUTER_REFERER,
        'X-Title': OPENROUTER_TITLE,
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (e) {
    // Stop pressed before headers arrived: return a clean partial, not an error.
    // The zero `run` keeps the result shape consistent so wrappers never NPE.
    if (e && e.name === 'AbortError') {
      return {
        text: '', reasoning: null, reasoningDetails: [], annotations: [],
        run: { model: modelId, reasoningTokens: 0, promptTokens: 0, completionTokens: 0, cost: 0, webSearch: false, finishReason: 'stopped' },
        stopped: true,
      };
    }
    throw e;
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenRouter API error: ${response.status}`);
  }

  const acc = createStreamAccumulator();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = acc.push(decoder.decode(value, { stream: true }));
      for (const ev of events) {
        if (ev.type === 'reasoning') hooks.onReasoning?.(ev.delta, ev.full);
        else if (ev.type === 'content') hooks.onContent?.(ev.delta, ev.full);
        else if (ev.type === 'annotations') hooks.onAnnotations?.(ev.annotations);
      }
    }
  } catch (e) {
    // Cancel (not just release) so the HTTP body/connection is torn down promptly
    // on abort or a mid-stream error rather than lingering until GC.
    try { reader.cancel(); } catch { /* best effort */ }
    if (e && e.name === 'AbortError') stopped = true;
    else throw e;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const r = acc.result();
  const usage = r.usage || {};
  const usedModel = r.model || modelId;
  const run = {
    model: usedModel,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    cost: typeof usage.cost === 'number' ? usage.cost : 0,
    webSearch: Array.isArray(r.annotations) && r.annotations.length > 0,
    finishReason: r.finishReason,
  };

  // A custom slug that produced a response "works" — remember it (no-op for curated).
  addCustomModel(modelId);
  if (r.usage) {
    trackUsage({
      provider: String(usedModel).split('/')[0] || 'openrouter',
      model: usedModel,
      feature: feature || 'chat',
      inputTokens: run.promptTokens,
      outputTokens: run.completionTokens,
      reasoningTokens: run.reasoningTokens,
      cost: run.cost,
    });
  }

  // Empty-content handling — never dump raw JSON (the old `text || JSON.stringify`).
  if (!r.text && !stopped) {
    if (r.finishReason === 'length') {
      throw new Error('The response hit the token cap before finishing — lower the reasoning effort or choose a model with a higher limit, then try again.');
    }
    throw new Error('The model returned an empty response. Please try again.');
  }

  // Surface run metadata to callers that buffer the answer (the JSON flows) so
  // they can show a token/cost readout without changing their return shape.
  // Success-path only: aborts/empty responses return or throw above this point.
  hooks.onRun?.(run);

  return {
    text: r.text,
    reasoning: r.reasoning || null,
    reasoningDetails: r.reasoningDetails,
    annotations: r.annotations,
    run,
    stopped,
  };
}

// Buffer-to-completion wrapper: every non-live caller routes here, so reasoning
// capture, citations, token/cost tracking and the empty-content fix apply
// uniformly. Returns a plain string by default; the structured object (used by
// the chat UI) when options.structured. options.hooks/options.signal flow through
// to streamOpenRouter for the live JSON flows.
async function callOpenRouter(modelId, messages, options = {}) {
  const res = await streamOpenRouter(modelId, messages, options, options.hooks || {});
  if (options.structured) {
    return {
      text: res.text,
      thinking: res.reasoning, // back-compat name retained for existing callers
      reasoning: res.reasoning,
      reasoningDetails: res.reasoningDetails,
      annotations: res.annotations,
      usedWebSearch: res.run.webSearch,
      run: res.run,
      stopped: res.stopped,
    };
  }
  return res.text;
}

/**
 * Main chat function
 * @param {string} modelId - OpenRouter model slug (e.g., 'anthropic/claude-sonnet-4.5')
 * @param {Array} messages - Array of message objects with role and content
 * @param {boolean} includeContext - Whether to include resume context
 * @param {Object} options - Additional options
 * @param {string} options.reasoningEffort - Reasoning effort level: 'none', 'low', 'medium', 'high'
 * @param {boolean} options.webSearch - Whether to enable web search (OpenRouter web plugin)
 * @returns {Promise<string>} AI response
 */
export async function chat(modelId, messages, includeContext = true, options = {}) {
  const validModelId = validateModelId(modelId);
  if (!getApiKey()) throw new Error('No OpenRouter API key configured. Please add your key in settings.');

  let processedMessages = [...messages];
  if (includeContext && processedMessages.length > 0) {
    const context = getResumeContext();
    const lastUserIndex = processedMessages.map((m) => m.role).lastIndexOf('user');
    if (lastUserIndex >= 0) {
      processedMessages[lastUserIndex] = {
        ...processedMessages[lastUserIndex],
        content: `${context}\n\n---\n\nUser request: ${processedMessages[lastUserIndex].content}`,
      };
    }
  }

  const { hooks, ...rest } = options;
  // Always tell the model which résumé is active, so a thread continued under a
  // different résumé isn't reasoned about against the old one. getResumeContext()
  // already attaches the résumé's data; this is the explicit one-line cue.
  const baseSystem = rest.systemPrompt || SYSTEM_PROMPT;
  const activeName = store.getData()?.name;
  const systemPrompt = activeName
    ? `${baseSystem}\n\nThe user is currently working on the résumé "${activeName}".`
    : baseSystem;
  const res = await streamOpenRouter(validModelId, processedMessages, { ...rest, systemPrompt }, hooks || {});
  if (options.structured) {
    return {
      text: res.text, thinking: res.reasoning, reasoning: res.reasoning,
      reasoningDetails: res.reasoningDetails, annotations: res.annotations,
      usedWebSearch: res.run.webSearch, run: res.run, stopped: res.stopped,
    };
  }
  return res.text;
}

// Helper functions for common operations
export async function rewriteText(modelId, text, instruction = 'Improve this text to be more impactful and professional') {
  const messages = [{
    role: 'user',
    content: `${instruction}:\n\n"${text}"\n\nProvide only the improved text without any explanation.`
  }];
  
  return chat(modelId, messages, true, { feature: 'generate' });
}

export async function generateBullets(modelId, context, count = 3, options = {}) {
  const messages = [{
    role: 'user',
    content: `Based on the resume and this context: "${context}", generate ${count} impactful bullet points. Format as a numbered list.`
  }];
  
  return chat(modelId, messages, true, { feature: 'generate', ...options });
}

export async function getFeedback(modelId, options = {}) {
  const messages = [{
    role: 'user',
    content: `Please review my resume and provide constructive feedback. Focus on:
1. Overall impression and strengths
2. Areas for improvement
3. Specific suggestions for each section
4. Any missing elements that would strengthen the resume`
  }];
  
  return chat(modelId, messages, true, { feature: 'feedback', ...options });
}

export async function improveSummary(modelId, options = {}) {
  const messages = [{
    role: 'user',
    content: `Please rewrite my resume summary to be more compelling and impactful. Make it concise but powerful, highlighting key strengths and value proposition. Provide only the improved summary text.`
  }];
  
  return chat(modelId, messages, true, { feature: 'generate', ...options });
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
export async function generateResumeChanges(modelId, instruction, targetPath = null, additionalContext = null, featureName = 'generate', options = {}) {
  // Validate and potentially migrate the model ID
  const validModelId = validateModelId(modelId);
  if (!getApiKey()) {
    throw new Error('No OpenRouter API key configured. Please add your key in settings.');
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
  
  // Call AI with the change-generation system prompt
  const messages = [{ role: 'user', content: prompt }];
  const response = await callOpenRouter(validModelId, messages, {
    feature: featureName,
    systemPrompt: CHANGE_GENERATION_PROMPT,
    reasoningEffort: options.reasoningEffort,
    hooks: options.hooks,
    signal: options.signal,
  });
  
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
  } catch {
    console.error('Failed to parse AI response as JSON:', response);
    throw new Error('AI response was not valid JSON. Please try again.');
  }
}

/**
 * Analyze resume against job descriptions
 * @param {string} modelId - Model to use
 * @param {Array} jobDescriptions - Array of job description objects
 * @param {Object} options - Additional options
 * @param {string} options.reasoningEffort - Reasoning effort level: 'none', 'low', 'medium', 'high'
 * @returns {Object} Analysis results
 */
export async function analyzeAgainstJobs(modelId, jobDescriptions, options = {}) {
  // Validate and potentially migrate the model ID
  const validModelId = validateModelId(modelId);
  if (!getApiKey()) {
    throw new Error('No OpenRouter API key configured. Please add your key in settings.');
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
  const response = await callOpenRouter(validModelId, messages, {
    feature: 'analyze',
    reasoningEffort: options.reasoningEffort,
    systemPrompt: JOB_ANALYSIS_PROMPT,
    hooks: options.hooks,
    signal: options.signal,
  });
  
  try {
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }
    return JSON.parse(jsonStr);
  } catch {
    console.error('Failed to parse analysis response:', response);
    throw new Error('Failed to parse AI analysis. Please try again.');
  }
}

/**
 * Get available models for a specific provider
 * @param {string} provider - Provider name
 * @returns {Array} Array of model info objects
 */
export function getModelsForProvider(group) {
  return Object.entries(MODELS)
    .filter(([, config]) => config.group === group)
    .map(([id, config]) => ({ id, model: id, label: config.label, group: config.group }));
}

/**
 * Get all curated models grouped by display group (Anthropic / OpenAI / Google).
 * The slug IS the id and the wire `model`. Custom slugs aren't listed here.
 * @returns {Object} Models grouped by group label
 */
export function getAllModels() {
  const grouped = {};
  for (const [id, config] of Object.entries(MODELS)) {
    (grouped[config.group] = grouped[config.group] || []).push({
      id,
      model: id,
      label: config.label,
      group: config.group
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
export async function profileInterviewChat(modelId, conversationHistory, options = {}) {
  const validModelId = validateModelId(modelId);
  if (!getApiKey()) {
    throw new Error('No OpenRouter API key configured. Please add your key in settings.');
  }
  
  const messages = conversationHistory.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content
  }));
  return callOpenRouter(validModelId, messages, {
    feature: 'profile',
    systemPrompt: PROFILE_INTERVIEW_PROMPT,
    ...options
  });
}

/**
 * Extract profile data from interview conversation
 * @param {string} modelId - Model to use
 * @param {Array} conversationHistory - The interview conversation
 * @returns {Promise<Object>} Extracted profile data
 */
export async function extractProfileFromInterview(modelId, conversationHistory, options = {}) {
  const validModelId = validateModelId(modelId);
  if (!getApiKey()) {
    throw new Error('No OpenRouter API key configured. Please add your key in settings.');
  }
  
  // Format conversation for extraction
  let conversationText = 'Interview Conversation:\n\n';
  for (const msg of conversationHistory) {
    const role = msg.role === 'user' ? 'User' : 'Interviewer';
    conversationText += `${role}: ${msg.content}\n\n`;
  }
  
  const messages = [{ role: 'user', content: conversationText }];
  const response = await callOpenRouter(validModelId, messages, {
    feature: 'profile',
    systemPrompt: PROFILE_EXTRACTION_PROMPT,
    ...options
  });
  
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
