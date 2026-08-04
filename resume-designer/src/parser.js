/**
 * Resume Markdown Parser
 * Parses the specific markdown structure used in the resume files
 */

import { generateId } from './store.js';
import { assignGroupIds } from './experienceGroups.js';

export function parseResume(markdown) {
  const lines = markdown.split('\n');
  
  const resume = {
    name: '',
    tagline: '',
    contact: {
      location: '',
      email: '',
      phone: '',
      portfolio: '',
      instagram: ''
    },
    summary: '',
    sections: [],
    tools: '',
    experience: [],
    education: []
  };
  
  let currentSection = null;
  let currentExperience = null;
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i].trim();
    
    // Skip empty lines at the start
    if (!line && !resume.name) {
      i++;
      continue;
    }
    
    // Parse name (H1)
    if (line.startsWith('# ') && !resume.name) {
      resume.name = line.substring(2).trim();
      i++;
      continue;
    }
    
    // Parse tagline (bold line after name)
    // Only the header region (before the first `## `) can supply the tagline.
    // Without the currentSection guard, a resume with no tagline has its FIRST
    // experience date line stolen — and grouping multiplies bold lines per employer.
    if (line.startsWith('**') && line.endsWith('**') && !resume.tagline && !currentSection) {
      resume.tagline = line.slice(2, -2).trim();
      i++;
      continue;
    }
    
    // Parse contact info (lines with specific patterns)
    if (!resume.contact.location && (line.includes('Los Angeles') || line.includes('CA'))) {
      parseContactLine(line, resume.contact);
      i++;
      continue;
    }
    
    if (line.includes('@gmail.com') || line.includes('@') && line.includes('•')) {
      parseContactLine(line, resume.contact);
      i++;
      continue;
    }
    
    if (line.includes('Portfolio:') || line.includes('Instagram:')) {
      parseContactLine(line, resume.contact);
      i++;
      continue;
    }
    
    // Parse H2 sections
    if (line.startsWith('## ')) {
      const sectionTitle = line.substring(3).trim();
      
      if (sectionTitle === 'Summary') {
        // Collect summary text
        i++;
        const summaryLines = [];
        while (i < lines.length && !lines[i].trim().startsWith('##')) {
          if (lines[i].trim()) summaryLines.push(lines[i].trim());
          i++;
        }
        resume.summary = summaryLines.join(' ');
        continue;
      }
      
      if (sectionTitle === 'Tools') {
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('##')) {
          if (lines[i].trim()) resume.tools = lines[i].trim();
          i++;
        }
        continue;
      }
      
      if (sectionTitle === 'Experience' || sectionTitle.includes('Experience')) {
        currentSection = 'experience';
        i++;
        continue;
      }
      
      if (sectionTitle === 'Education') {
        currentSection = 'education';
        i++;
        // Parse education lines
        while (i < lines.length && !lines[i].trim().startsWith('##')) {
          const eduLine = lines[i].trim();
          if (eduLine) {
            resume.education.push(eduLine);
          }
          i++;
        }
        continue;
      }
      
      // Other sections (Core Skills, Highlights, Coordination & Leadership Strengths, etc.)
      const sectionContent = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('##')) {
        if (lines[i].trim()) sectionContent.push(lines[i].trim());
        i++;
      }
      
      if (sectionContent.length > 0) {
        resume.sections.push({
          title: sectionTitle,
          content: sectionContent
        });
      }
      continue;
    }
    
    // Parse H3 (Experience entries)
    if (line.startsWith('### ') && currentSection === 'experience') {
      // Save previous experience if exists
      if (currentExperience) {
        resume.experience.push(currentExperience);
      }
      
      // Parse title and company
      const titleLine = line.substring(4).trim();
      const { title, company, dates: inlineDates } = parseExperienceTitle(titleLine);

      currentExperience = {
        id: generateId('exp'),
        title,
        company,
        dates: inlineDates,
        bullets: []
      };
      
      i++;
      continue;
    }
    
    // Parse experience dates (bold line)
    if (currentExperience && line.startsWith('**') && line.endsWith('**')) {
      currentExperience.dates = line.slice(2, -2).trim();
      i++;
      continue;
    }
    
    // Parse experience bullets
    if (currentExperience && line.startsWith('-')) {
      currentExperience.bullets.push(formatBullet(line.substring(1).trim()));
      i++;
      continue;
    }
    
    i++;
  }
  
  // Don't forget the last experience entry
  if (currentExperience) {
    resume.experience.push(currentExperience);
  }

  // Same predicate the renderer uses, so import and render agree by
  // construction: consecutive entries at an identical company are one tenure.
  resume.experience = assignGroupIds(resume.experience);

  return resume;
}

function parseContactLine(line, contact) {
  // Split by bullet points
  const parts = line.split('•').map(p => p.trim());
  
  for (const part of parts) {
    if (part.includes('Los Angeles') || part.includes('CA') || part.includes('remote') || part.includes('relocate')) {
      if (!contact.location) contact.location = part;
      else contact.location += ' • ' + part;
    } else if (part.includes('@') && part.includes('.com') && !part.includes('Instagram')) {
      contact.email = part;
    } else if (/\d{3}-\d{3}-\d{4}/.test(part)) {
      contact.phone = part;
    } else if (part.includes('Portfolio:')) {
      contact.portfolio = part.replace('Portfolio:', '').trim();
    } else if (part.includes('Instagram:')) {
      contact.instagram = part.replace('Instagram:', '').trim();
    } else if (part.includes('www.') || part.includes('.com')) {
      contact.portfolio = part;
    }
  }
}

function parseExperienceTitle(titleLine) {
  // The exporter writes dates INLINE on the heading (`### Title — Company **Dates**`)
  // while the reader historically expected them on a separate bold line — which made
  // parse -> export -> re-import lossy (the dates folded into `company`). Accept both.
  let dates = '';
  let line = titleLine;
  const inline = line.match(/\s*\*\*([^*]+)\*\*\s*$/);
  if (inline) {
    dates = inline[1].trim();
    line = line.slice(0, inline.index).trim();
  }

  // Pattern: "Role — Company" or "Role — Project — Event"
  const parts = line.split('—').map(p => p.trim());

  if (parts.length >= 2) {
    return { title: parts[0], company: parts.slice(1).join(' — '), dates };
  }

  return { title: line, company: '', dates };
}

function formatBullet(text) {
  // Convert **text** to <strong>text</strong>
  return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
