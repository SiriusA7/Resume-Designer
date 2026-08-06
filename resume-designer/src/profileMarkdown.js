/**
 * User-profile ⇄ markdown conversion — framework-agnostic, pure functions
 * extracted from the former userProfilePanel.js so the React ProfileDialog (and
 * unit tests) can import them without the panel's DOM/import graph. No DOM, but
 * not dependency-free: it imports store.js (for generateId) and
 * experienceGroups.js (for assignGroupIds).
 */

import { generateId } from './store.js';
import { assignGroupIds } from './experienceGroups.js';

export const DEFAULT_PROFILE = {
  contactInfo: {
    fullName: '', email: '', phone: '', location: '',
    linkedin: '', portfolio: '', github: '', twitter: '', instagram: '',
  },
  personalSummary: '',
  careerGoals: '',
  workExperience: [],
  skills: [],
  education: [],
  projects: [],
  certifications: [],
  achievements: [],
  industryKnowledge: '',
  preferences: '',
  customSections: [],
};

/** Convert profile data to a portable markdown document. */
export function profileToMarkdown(profile) {
  let md = `# User Profile\n\n`;
  md += `> This file contains your professional background information.\n`;
  md += `> Edit the sections below and import back into On Paper.\n\n`;

  md += `## Personal Summary\n\n`;
  md += `${profile.personalSummary || '_Write a 2-3 sentence professional summary about yourself..._'}\n\n`;

  md += `## Career Goals\n\n`;
  md += `${profile.careerGoals || '_What roles are you targeting? What are your career aspirations?_'}\n\n`;

  md += `## Preferences\n\n`;
  md += `${profile.preferences || '_Work style preferences, industries of interest, location preferences, etc._'}\n\n`;

  md += `## Work Experience\n\n`;
  if (profile.workExperience && profile.workExperience.length > 0) {
    for (const exp of profile.workExperience) {
      md += `### ${exp.title || 'Job Title'} at ${exp.company || 'Company'}\n`;
      md += `**Dates:** ${exp.dates || 'Start - End'}\n\n`;
      md += `${exp.details || '_Describe your responsibilities, achievements, technologies used, team size, and impact..._'}\n\n`;
    }
  } else {
    md += `### Job Title at Company\n`;
    md += `**Dates:** Start - End\n\n`;
    md += `_Describe your responsibilities, achievements, technologies used, team size, and impact..._\n\n`;
  }

  md += `## Skills\n\n`;
  md += `| Skill | Proficiency | Years |\n`;
  md += `|-------|-------------|-------|\n`;
  if (profile.skills && profile.skills.length > 0) {
    for (const skill of profile.skills) {
      md += `| ${skill.name || 'Skill Name'} | ${skill.proficiency || 'intermediate'} | ${skill.years || ''} |\n`;
    }
  } else {
    md += `| _Skill Name_ | beginner/intermediate/advanced/expert | _Years_ |\n`;
  }
  md += `\n`;

  md += `## Industry Knowledge\n\n`;
  md += `${profile.industryKnowledge || '_Domains, methodologies, tools, and frameworks you are familiar with..._'}\n\n`;

  md += `## Education\n\n`;
  if (profile.education && profile.education.length > 0) {
    for (const edu of profile.education) {
      md += `### ${edu.degree || 'Degree/Program'} - ${edu.institution || 'Institution'}\n`;
      md += `**Dates:** ${edu.dates || 'Year'}\n\n`;
      md += `${edu.details || '_Notable courses, projects, thesis, honors, activities..._'}\n\n`;
    }
  } else {
    md += `### Degree/Program - Institution\n`;
    md += `**Dates:** Year\n\n`;
    md += `_Notable courses, projects, thesis, honors, activities..._\n\n`;
  }

  md += `## Projects\n\n`;
  if (profile.projects && profile.projects.length > 0) {
    for (const proj of profile.projects) {
      md += `### ${proj.name || 'Project Name'}\n`;
      if (proj.url) md += `**URL:** ${proj.url}\n\n`;
      md += `${proj.description || '_Describe the project, technologies used, your role, and outcomes..._'}\n\n`;
    }
  } else {
    md += `### Project Name\n`;
    md += `**URL:** https://example.com (optional)\n\n`;
    md += `_Describe the project, technologies used, your role, and outcomes..._\n\n`;
  }

  md += `## Certifications\n\n`;
  if (profile.certifications && profile.certifications.length > 0) {
    for (const cert of profile.certifications) {
      md += `- ${cert.name || 'Certification Name'}${cert.year ? ` (${cert.year})` : ''}\n`;
    }
  } else {
    md += `- _Certification Name (Year)_\n`;
  }
  md += `\n`;

  md += `## Achievements\n\n`;
  if (profile.achievements && profile.achievements.length > 0) {
    for (const ach of profile.achievements) {
      md += `- ${ach.description || 'Achievement description'}\n`;
    }
  } else {
    md += `- _Notable accomplishment, recognition, or award..._\n`;
  }
  md += `\n`;

  md += `## Custom Sections\n\n`;
  md += `> Add any additional sections below using the format:\n`;
  md += `> ### Section Title\n`;
  md += `> Content here...\n\n`;
  if (profile.customSections && profile.customSections.length > 0) {
    for (const section of profile.customSections) {
      md += `### ${section.title || 'Section Title'}\n\n`;
      md += `${section.content || '_Content..._'}\n\n`;
    }
  }

  return md;
}

/** Parse a markdown document back into profile data. */
export function markdownToProfile(markdown, { group = false } = {}) {
  // Deep-ish copy: a shallow spread ALIASES DEFAULT_PROFILE's arrays, so a parser
  // that pushes would permanently mutate the module constant for the session.
  const profile = {
    ...DEFAULT_PROFILE,
    contactInfo: { ...DEFAULT_PROFILE.contactInfo },
    workExperience: [], skills: [], education: [], projects: [],
    certifications: [], achievements: [], customSections: [],
  };
  const sections = markdown.split(/^## /gm).slice(1);

  for (const section of sections) {
    const lines = section.split('\n');
    const sectionTitle = lines[0].trim().toLowerCase();
    const sectionContent = lines.slice(1).join('\n').trim();

    if (sectionTitle.includes('personal summary')) {
      profile.personalSummary = cleanContent(sectionContent);
    } else if (sectionTitle.includes('career goals')) {
      profile.careerGoals = cleanContent(sectionContent);
    } else if (sectionTitle.includes('preferences')) {
      profile.preferences = cleanContent(sectionContent);
    } else if (sectionTitle.includes('industry knowledge')) {
      profile.industryKnowledge = cleanContent(sectionContent);
    } else if (sectionTitle.includes('work experience')) {
      profile.workExperience = group
        ? assignGroupIds(parseWorkExperience(sectionContent))
        : parseWorkExperience(sectionContent);
    } else if (sectionTitle.includes('skills')) {
      profile.skills = parseSkillsTable(sectionContent);
    } else if (sectionTitle.includes('education')) {
      profile.education = parseEducation(sectionContent);
    } else if (sectionTitle.includes('projects')) {
      profile.projects = parseProjects(sectionContent);
    } else if (sectionTitle.includes('certifications')) {
      profile.certifications = parseCertifications(sectionContent);
    } else if (sectionTitle.includes('achievements')) {
      profile.achievements = parseAchievements(sectionContent);
    } else if (sectionTitle.includes('custom sections')) {
      profile.customSections = parseCustomSections(sectionContent);
    }
  }

  return profile;
}

// Remove placeholder italics + instruction blockquotes.
function cleanContent(content) {
  let cleaned = content.replace(/^_[^_]+_$/gm, '').trim();
  cleaned = cleaned.replace(/^>.*$/gm, '').trim();
  return cleaned;
}

function parseWorkExperience(content) {
  const experiences = [];
  const entries = content.split(/^### /gm).slice(1);
  for (const entry of entries) {
    const lines = entry.split('\n');
    const titleLine = lines[0].trim();
    const titleMatch = titleLine.match(/^(.+?)\s+at\s+(.+)$/i);
    const title = titleMatch ? titleMatch[1].trim() : titleLine;
    const company = titleMatch ? titleMatch[2].trim() : '';

    let dates = '';
    let detailsStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('**Dates:**')) {
        dates = line.replace('**Dates:**', '').trim();
        detailsStart = i + 1;
        break;
      }
    }
    const details = cleanContent(lines.slice(detailsStart).join('\n'));
    if (title === 'Job Title' && company === 'Company' && !details) continue;
    if (title || company || details) experiences.push({ id: generateId('exp'), title, company, dates, details });
  }
  return experiences;
}

function parseSkillsTable(content) {
  const skills = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.includes('---') || (line.toLowerCase().includes('skill') && line.toLowerCase().includes('proficiency'))) {
      continue;
    }
    const match = line.match(/\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*)\s*\|/);
    if (match) {
      const name = match[1].trim().replace(/^_|_$/g, '');
      const proficiency = match[2].trim().replace(/^_|_$/g, '');
      const years = match[3].trim().replace(/^_|_$/g, '');
      if (name === 'Skill Name' || name.startsWith('_')) continue;
      const validProficiencies = ['beginner', 'intermediate', 'advanced', 'expert'];
      const normalizedProficiency = validProficiencies.includes(proficiency.toLowerCase())
        ? proficiency.toLowerCase() : '';
      if (name) skills.push({ name, proficiency: normalizedProficiency, years });
    }
  }
  return skills;
}

function parseEducation(content) {
  const education = [];
  const entries = content.split(/^### /gm).slice(1);
  for (const entry of entries) {
    const lines = entry.split('\n');
    const titleLine = lines[0].trim();
    const titleMatch = titleLine.match(/^(.+?)\s*-\s*(.+)$/);
    const degree = titleMatch ? titleMatch[1].trim() : titleLine;
    const institution = titleMatch ? titleMatch[2].trim() : '';

    let dates = '';
    let detailsStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('**Dates:**')) {
        dates = line.replace('**Dates:**', '').trim();
        detailsStart = i + 1;
        break;
      }
    }
    const details = cleanContent(lines.slice(detailsStart).join('\n'));
    if (degree === 'Degree/Program' && institution === 'Institution' && !details) continue;
    if (degree || institution || details) education.push({ degree, institution, dates, details });
  }
  return education;
}

function parseProjects(content) {
  const projects = [];
  const entries = content.split(/^### /gm).slice(1);
  for (const entry of entries) {
    const lines = entry.split('\n');
    const name = lines[0].trim();

    let url = '';
    let descStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('**URL:**')) {
        url = line.replace('**URL:**', '').trim();
        // Drop the "(optional)" annotation by taking the first token, and discard
        // example.com placeholders by host (not substring). Protocol-less URLs
        // are preserved by retrying with an https:// prefix purely to read host.
        const candidate = url.split(/\s+/)[0] || '';
        let urlHost = '';
        try {
          urlHost = new URL(candidate).hostname.toLowerCase();
        } catch {
          try { urlHost = new URL(`https://${candidate}`).hostname.toLowerCase(); } catch { urlHost = ''; }
        }
        url = (urlHost === 'example.com' || urlHost.endsWith('.example.com')) ? '' : candidate;
        descStart = i + 1;
        break;
      }
    }
    const description = cleanContent(lines.slice(descStart).join('\n'));
    if (name === 'Project Name' && !description) continue;
    if (name || description) projects.push({ name, url, description });
  }
  return projects;
}

function parseCertifications(content) {
  const certifications = [];
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('-')) continue;
    const text = line.replace(/^-\s*/, '').trim();
    if (text.startsWith('_') || text === 'Certification Name (Year)') continue;
    const match = text.match(/^(.+?)\s*\((\d{4})\)$/);
    if (match) certifications.push({ name: match[1].trim(), year: match[2] });
    else if (text) certifications.push({ name: text, year: '' });
  }
  return certifications;
}

function parseAchievements(content) {
  const achievements = [];
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('-')) continue;
    const text = line.replace(/^-\s*/, '').trim();
    if (text.startsWith('_') || text === 'Achievement description') continue;
    if (text) achievements.push({ description: text });
  }
  return achievements;
}

function parseCustomSections(content) {
  const sections = [];
  const cleanedContent = content.replace(/^>.*$/gm, '').trim();
  const entries = cleanedContent.split(/^### /gm).slice(1);
  for (const entry of entries) {
    const lines = entry.split('\n');
    const title = lines[0].trim();
    const sectionContent = cleanContent(lines.slice(1).join('\n'));
    if (title === 'Section Title' && !sectionContent) continue;
    if (title || sectionContent) sections.push({ title, content: sectionContent });
  }
  return sections;
}
