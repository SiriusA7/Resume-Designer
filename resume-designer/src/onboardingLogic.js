/**
 * Onboarding wizard — pure logic.
 *
 * Framework-agnostic helpers extracted verbatim from the former onboarding.js so
 * the React wizard (src/components/onboarding/OnboardingWizard.jsx) and tests can
 * call them without the wizard's DOM. Everything here is data-in / data-out (plus
 * the necessary store/persistence/AI side effects); no document access.
 */
import { generateId, experienceSortValue } from './store.js';
import { sortRunAware, assignGroupIds, datesAreContinuous } from './experienceGroups.js';
import { getDefaultModelId, chat, generateResumeFromProfileForJob, getAllModels, getCustomModels, isConfigured, GROUNDING_RULES } from './aiService.js';
import { generateUniqueVariantName, saveVariant } from './persistence.js';
import { parseResumeText } from './resumeParser.js';
import { addJobDescription } from './jobDescriptions.js';
import { loadVariant } from './variantManager.js';

// Interview questions for the AI-guided "Start Fresh" flow.
export const INTERVIEW_QUESTIONS = [
  { id: 'name', question: "What's your full name?", field: 'name', type: 'text' },
  { id: 'title', question: "What's your professional title or the role you're seeking?", field: 'tagline', type: 'text' },
  { id: 'contact', question: "What's your email address and location (city, state)?", field: 'contact', type: 'text' },
  { id: 'summary', question: "Tell me about yourself in 2-3 sentences. What's your professional background and what are you looking for?", field: 'summary', type: 'textarea', aiAssist: true },
  { id: 'experience', question: "Tell me about your most recent work experience. What was your role, company, and key achievements?", field: 'experience', type: 'textarea', aiAssist: true },
  { id: 'skills', question: 'What are your key skills? List them separated by commas.', field: 'skills', type: 'textarea' },
];

/**
 * Validate an OpenRouter API key by hitting the key-info endpoint.
 */
export async function validateOpenRouterKey(key) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Flat list of models for the wizard's model <select>, including cached custom slugs.
 */
export function getAvailableModelsForSelector() {
  if (!isConfigured()) return [];
  const grouped = getAllModels(); // { Anthropic: [{ id, label, group }], ... }
  const available = [];
  for (const models of Object.values(grouped)) {
    for (const model of models) {
      available.push({ id: model.id, label: model.label, group: model.group });
    }
  }
  for (const slug of getCustomModels()) {
    available.push({ id: slug, label: slug, group: 'Custom' });
  }
  return available;
}

/**
 * Parse resume text using AI if available, falling back to the local parser.
 */
export async function parseResumeWithAI(text) {
  const modelId = getDefaultModelId();

  // No AI available → basic parsing.
  if (!modelId) {
    return parseResumeText(text);
  }

  try {
    const response = await chat(modelId, [{
      role: 'user',
      content: `Parse this resume text and extract structured information. Return ONLY a valid JSON object (no markdown, no explanation) with this structure:
{
  "name": "Full Name",
  "tagline": "Professional Title",
  "email": "email@example.com",
  "phone": "phone number",
  "location": "City, State",
  "linkedin": "linkedin url if present",
  "portfolio": "portfolio url if present",
  "summary": "Professional summary paragraph",
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "location": "Location",
      "startDate": "Start Date",
      "endDate": "End Date or Present",
      "bullets": ["Achievement 1", "Achievement 2"]
    }
  ],
  "education": [
    {
      "degree": "Degree Name",
      "school": "School Name",
      "year": "Graduation Year"
    }
  ],
  "skills": ["Skill 1", "Skill 2"],
  "sections": []
}

Resume text:
${text}`,
    }], false);

    const responseText = typeof response === 'string' ? response : (response?.text || response?.response || '');

    try {
      let jsonStr = responseText.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      return JSON.parse(jsonStr);
    } catch {
      console.warn('AI response was not valid JSON, falling back to basic parsing');
      return parseResumeText(text);
    }
  } catch (error) {
    console.warn('AI parsing failed, falling back to basic parsing:', error);
    return parseResumeText(text);
  }
}

/**
 * Extract raw text from an uploaded file (TXT/PDF/DOCX) via the resume parser.
 */
export async function extractFileText(file) {
  const { parseResumeFile } = await import('./resumeParser.js');
  const result = await parseResumeFile(file);
  return result.text;
}

/**
 * Improve a single interview answer with AI. Returns the improved text.
 */
export async function improveInterviewAnswer(questionText, value, modelId) {
  const model = modelId || 'anthropic/claude-sonnet-4.5';
  const response = await chat(model, [{
    role: 'user',
    content: `I'm writing my resume. Here's my answer to "${questionText}": "${value}". Please improve this to be more professional and impactful for a resume. Return only the improved text, no explanation.`,
  }], false);
  return (typeof response === 'string' ? response : (response?.text || response?.response || '')).trim();
}

/**
 * Build a parsedResume object from the interview answers (no mutation).
 */
export function buildResumeFromInterview(answers) {
  let email = '';
  let location = '';
  const contactMatch = (answers.contact || '').match(/([^\s,]+@[^\s,]+)/);
  if (contactMatch) email = contactMatch[1];
  const locMatch = (answers.contact || '').replace(email, '').trim();
  location = locMatch || '';

  const skills = (answers.skills || '').split(',').map((s) => s.trim()).filter((s) => s);

  return {
    name: answers.name || 'Your Name',
    tagline: answers.title || 'Professional Title',
    email,
    location,
    summary: answers.summary || '',
    sections: skills.length > 0 ? [{ title: 'Skills', content: skills }] : [],
    experience: answers.experience ? [{
      title: 'Position', company: 'Company', dates: 'Present', bullets: [answers.experience],
    }] : [],
    education: [],
  };
}

/**
 * Generate a tailored resume from the saved profile for a target job.
 * @returns {Promise<{resume: Object, gaps: Array<{requirement: string, severity: string, note: string}>}>}
 */
export function generateResumeForJob(modelId, targetJob, reasoningEffort, options = {}) {
  if (!modelId) throw new Error('No AI model configured');
  return generateResumeFromProfileForJob(modelId, targetJob, { reasoningEffort, ...options });
}

/**
 * Use AI to tailor a parsed resume to the given job descriptions.
 * Returns a NEW resume object with summary/highlights/skills merged in.
 * Throws on AI/parse failure (the caller falls back to the untailored resume).
 */
export async function tailorResume(parsedResume, jobDescriptions) {
  const modelId = getDefaultModelId();
  if (!modelId) return parsedResume;

  const resume = parsedResume || {};
  const jobs = jobDescriptions || [];
  if (jobs.length === 0) return parsedResume;

  const jobContext = jobs.map((j) => `
Job Title: ${j.title}
Company: ${j.company}
Description: ${j.description}
`).join('\n---\n');

  const resumeContext = `
Name: ${resume.name || 'Not provided'}
Current Title: ${resume.tagline || 'Not provided'}
Summary: ${resume.summary || 'Not provided'}
Skills: ${(resume.skills || []).join(', ') || 'Not provided'}
Tools: ${(Array.isArray(resume.tools) ? resume.tools.join(', ') : (resume.tools || '')) || 'Not provided'}
Experience: ${(resume.experience || []).map((e) => `${e.title} at ${e.company}`).join('; ') || 'Not provided'}
`;

  const prompt = `You are helping tailor a resume for specific job applications. Based on the resume and target job(s) below, create:

${GROUNDING_RULES}

1. A professional SUMMARY (2-3 sentences) positioning the candidate for the target role(s) using only what the resume below evidences
2. A HIGHLIGHTS section (3-4 bullet points) of DISTINCT, career-level achievements already present in the resume — NOT restatements of the experience bullets, and NOT new claims
3. Identify KEY SKILLS that match the job requirements AND appear in the resume

Resume Information:
${resumeContext}

Target Job(s):
${jobContext}

Return ONLY valid JSON (no markdown, no explanation):
{
  "summary": "Professional summary tailored to the target role...",
  "highlights": [
    "Key achievement or skill relevant to the job",
    "Another relevant highlight",
    "..."
  ],
  "relevantSkills": ["skill1", "skill2", "skill3"]
}`;

  const response = await chat(modelId, [{ role: 'user', content: prompt }], false);
  const responseText = typeof response === 'string' ? response : (response?.text || response?.response || '');

  let jsonStr = responseText.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const tailored = JSON.parse(jsonStr);

  const next = { ...resume };
  if (tailored.summary) next.summary = tailored.summary;
  if (tailored.highlights && tailored.highlights.length > 0) next.highlights = tailored.highlights;
  if (tailored.relevantSkills && tailored.relevantSkills.length > 0) {
    // Merge with existing skills, keeping only the 12 most relevant.
    const existingSkills = resume.skills || [];
    next.skills = [...new Set([...tailored.relevantSkills, ...existingSkills])].slice(0, 12);
  }
  return next;
}

/**
 * Transform a parsedResume into the renderer-shaped variant data (pure).
 */
export function buildResumeData(resume) {
  const r = resume || {};

  // education → strings ("Degree - School (Year)")
  let educationLines = [];
  if (r.education && r.education.length > 0) {
    educationLines = r.education.map((edu) => {
      if (typeof edu === 'string') return edu;
      const parts = [];
      if (edu.degree) parts.push(edu.degree);
      if (edu.school) parts.push(edu.school);
      if (edu.year) parts.push(`(${edu.year})`);
      return parts.join(' - ') || 'Education';
    });
  }

  const sections = [];

  // Highlights first (most important for tailored resumes).
  if (r.highlights && r.highlights.length > 0) {
    sections.push({ id: 'highlights', title: 'Highlights', content: r.highlights.map((h) => `- ${h}`) });
  }

  // Skills as individually-editable bulleted items, capped to the 12 most relevant.
  // Bulleted is the app-wide default; the user can switch a section to inline tags.
  if (r.skills && r.skills.length > 0) {
    sections.push({ id: 'skills', title: 'Skills', type: 'list', content: r.skills.slice(0, 12).map((s) => String(s)) });
  }

  if (r.certifications && r.certifications.length > 0) {
    sections.push({ id: 'certifications', title: 'Certifications', content: r.certifications.map((c) => (typeof c === 'string' ? c : c.name || c)) });
  }

  if (r.sections && r.sections.length > 0) {
    for (const section of r.sections) {
      if (!sections.some((s) => s.title?.toLowerCase() === section.title?.toLowerCase())) {
        sections.push(section);
      }
    }
  }

  // Normalize + order experience: stable id, capture AI relevance order in
  // _relevanceRank, then default to chronological (newest first).
  let experience = (r.experience || []).map((exp, i) => ({
    ...exp,
    id: exp.id || generateId('exp'),
    _relevanceRank: i,
  }));
  // Mint one group id per run of consecutive entries at the same employer BEFORE
  // sorting: sortRunAware only respects an EXISTING _groupId, and this fresh AI
  // output has none yet, so assignGroupIds must read the run off the AI's own raw
  // adjacency first. Only then can sortRunAware reorder chronologically without
  // shredding that run apart — without this nothing the AI produces is ever grouped.
  //
  // This depends on the model emitting one employer's roles CONSECUTIVELY, which
  // buildGenerateResumePrompt requires explicitly — the prompt otherwise asks for
  // relevance ordering, which can legitimately place a different employer between
  // two roles at the same one, leaving nothing for adjacency to find. The output
  // schema deliberately carries no _groupId (the model is never asked to author
  // grouping), so ordering plus the dates are the only channels available.
  //
  // Adjacency alone is NOT sufficient here, because this input may be INCOMPLETE:
  // the generator omits jobs irrelevant to the target role, and a pasted resume
  // omits jobs the user chose to leave out, so two separate stints at one employer
  // can arrive adjacent. Fusing them would print one company header spanning both,
  // asserting continuous employment that never happened. datesAreContinuous
  // requires the two roles' machine-readable, month-precise ranges to overlap or
  // abut (<= 1 month) before they may share a header; anything missing, year-only,
  // or gapped renders ungrouped — the pre-feature rendering: plainer, never false.
  const grouped = assignGroupIds(experience, undefined, datesAreContinuous);
  experience = sortRunAware(
    grouped,
    (run) => Math.max(...run.map(experienceSortValue)),
    (a, b) => b - a,
  );

  return {
    name: r.name || 'Your Name',
    tagline: r.tagline || 'Professional Title',
    summary: r.summary || '',
    contact: {
      email: r.email || '',
      phone: r.phone || '',
      location: r.location || '',
      linkedin: r.linkedin || '',
      portfolio: r.portfolio || '',
    },
    experience,
    education: educationLines,
    sections,
    // Renderer expects a ' • '-joined string for tools.
    tools: Array.isArray(r.tools) ? r.tools.join(' • ') : (r.tools || ''),
  };
}

/**
 * Persist the finished onboarding resume as a new variant and load it.
 * Returns the new variant id.
 */
export function saveOnboardingResume({ parsedResume, mode, targetJob, jobDescriptions }) {
  // 'job' mode skips the dedicated JD step, so commit its JDs here.
  if (mode === 'job' && jobDescriptions && jobDescriptions.length > 0) {
    for (const jd of jobDescriptions) addJobDescription(jd);
  }

  const resume = parsedResume || {};
  const variantId = `custom-${Date.now()}`;

  let baseName;
  if (mode === 'job' && targetJob) {
    const jobTitle = targetJob.title || 'Role';
    const company = targetJob.company || '';
    baseName = company ? `${jobTitle} - ${company}` : jobTitle;
  } else {
    baseName = resume.name || 'My Resume';
  }
  const variantName = generateUniqueVariantName(baseName);
  const resumeData = buildResumeData(resume);

  // Save then load (sets current id, initializes persistence, notifies the React
  // header, which re-renders its variant list automatically). saveVariant
  // returns false when the storage write fails (quota exceeded in the browser), and
  // loadVariant returns false when the variant isn't readable back — without
  // this check the wizard would show "Your Resume is Ready!" while the resume
  // silently never persisted (old resume on screen, nothing in the dropdown).
  const saved = saveVariant(variantId, variantName, resumeData);
  if (!saved || !loadVariant(variantId)) {
    throw new Error(
      "Could not save the new resume: the app's local storage is full. "
      + 'Free up space by deleting resumes you no longer need, then try again. '
      + 'You can back up everything first via Settings → Data → Export Backup.',
    );
  }
  return variantId;
}

/** Commit a list of job descriptions to the saved JD store. */
export function commitJobDescriptions(jobDescriptions) {
  for (const jd of jobDescriptions || []) addJobDescription(jd);
}
