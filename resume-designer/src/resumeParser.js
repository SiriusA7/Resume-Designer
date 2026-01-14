/**
 * Resume Parser
 * Parses resume content from various formats into structured data
 */

import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker - use the worker from the npm package
// Import with ?url to get the bundled worker path
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * Parse plain text resume into structured format
 * @param {string} text - Plain text resume content
 * @returns {Object} Parsed resume data
 */
export function parseResumeText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const resume = {
    name: '',
    tagline: '',
    email: '',
    phone: '',
    location: '',
    website: '',
    linkedin: '',
    summary: '',
    sections: [],
    experience: [],
    education: []
  };
  
  // Common section headers
  const sectionHeaders = {
    summary: /^(summary|profile|about|objective|professional\s*summary)/i,
    experience: /^(experience|work\s*experience|employment|professional\s*experience|work\s*history)/i,
    education: /^(education|academic|qualifications|degrees)/i,
    skills: /^(skills|technical\s*skills|core\s*competencies|expertise|proficiencies)/i,
    projects: /^(projects|portfolio|work\s*samples)/i,
    certifications: /^(certifications|certificates|licenses)/i,
    awards: /^(awards|honors|achievements|accomplishments)/i,
    languages: /^(languages|language\s*skills)/i,
    interests: /^(interests|hobbies|activities)/i,
    references: /^(references|referees)/i
  };
  
  // Try to extract name from first line
  if (lines.length > 0) {
    const firstLine = lines[0];
    // Name is usually the first line, short and without common section words
    if (firstLine.length < 50 && !Object.values(sectionHeaders).some(r => r.test(firstLine))) {
      resume.name = firstLine;
    }
  }
  
  // Try to extract contact info from early lines
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];
    
    // Email
    const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch && !resume.email) {
      resume.email = emailMatch[1];
    }
    
    // Phone
    const phoneMatch = line.match(/(\+?[\d\s\-().]{10,})/);
    if (phoneMatch && !resume.phone) {
      resume.phone = phoneMatch[1].trim();
    }
    
    // LinkedIn
    const linkedinMatch = line.match(/(linkedin\.com\/in\/[a-zA-Z0-9_-]+)/i);
    if (linkedinMatch && !resume.linkedin) {
      resume.linkedin = linkedinMatch[1];
    }
    
    // Website
    const websiteMatch = line.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/i);
    if (websiteMatch && !resume.website && !linkedinMatch) {
      resume.website = websiteMatch[1];
    }
    
    // Location (city, state pattern)
    const locationMatch = line.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),?\s*([A-Z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    if (locationMatch && !resume.location && !emailMatch && !phoneMatch) {
      resume.location = line;
    }
    
    // Title/tagline (second non-contact line, often)
    if (i === 1 && !resume.tagline && !emailMatch && !phoneMatch && line.length < 80) {
      resume.tagline = line;
    }
  }
  
  // Parse sections
  let currentSection = null;
  let currentContent = [];
  let currentExperience = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this is a section header
    let foundSection = null;
    for (const [section, pattern] of Object.entries(sectionHeaders)) {
      if (pattern.test(line)) {
        foundSection = section;
        break;
      }
    }
    
    if (foundSection) {
      // Save previous section
      if (currentSection) {
        saveSection(resume, currentSection, currentContent, currentExperience);
      }
      
      currentSection = foundSection;
      currentContent = [];
      currentExperience = null;
      continue;
    }
    
    // Add content to current section
    if (currentSection) {
      // Check for experience entry pattern
      if (currentSection === 'experience') {
        // Pattern: Title at Company | Date pattern
        const expMatch = line.match(/^(.+?)\s*(?:at|@|-|–|,)\s*(.+?)(?:\s*[\|•]\s*|\s{2,})(.+)?$/i);
        const dateMatch = line.match(/(\d{4}\s*[-–]\s*(?:\d{4}|present|current))|(\w+\s+\d{4}\s*[-–]\s*(?:\w+\s+\d{4}|present|current))/i);
        
        if (expMatch || (line.length < 100 && /[A-Z]/.test(line[0]) && !line.startsWith('•') && !line.startsWith('-'))) {
          // New experience entry
          if (currentExperience) {
            resume.experience.push(currentExperience);
          }
          
          if (expMatch) {
            currentExperience = {
              title: expMatch[1].trim(),
              company: expMatch[2].trim(),
              dates: expMatch[3]?.trim() || '',
              bullets: []
            };
          } else {
            currentExperience = {
              title: line,
              company: '',
              dates: dateMatch ? dateMatch[0] : '',
              bullets: []
            };
          }
        } else if (currentExperience) {
          // Bullet point
          const bulletText = line.replace(/^[•\-\*]\s*/, '').trim();
          if (bulletText.length > 0) {
            // Check if this line is company/date info
            if (!currentExperience.company && line.length < 80 && !line.startsWith('•') && !line.startsWith('-')) {
              currentExperience.company = bulletText;
            } else if (!currentExperience.dates && dateMatch) {
              currentExperience.dates = dateMatch[0];
            } else {
              currentExperience.bullets.push(bulletText);
            }
          }
        }
      } else {
        // Regular content
        const bulletText = line.replace(/^[•\-\*]\s*/, '').trim();
        if (bulletText.length > 0) {
          currentContent.push(bulletText);
        }
      }
    }
  }
  
  // Save last section
  if (currentSection) {
    saveSection(resume, currentSection, currentContent, currentExperience);
  }
  
  return resume;
}

/**
 * Save parsed section to resume
 */
function saveSection(resume, sectionName, content, currentExperience) {
  switch (sectionName) {
    case 'summary':
      resume.summary = content.join(' ');
      break;
      
    case 'experience':
      if (currentExperience) {
        resume.experience.push(currentExperience);
      }
      break;
      
    case 'education':
      resume.education = content;
      break;
      
    case 'skills':
    case 'projects':
    case 'certifications':
    case 'awards':
    case 'languages':
    case 'interests':
      if (content.length > 0) {
        // Check if content is comma-separated on one line
        if (content.length === 1 && content[0].includes(',')) {
          content = content[0].split(',').map(s => s.trim()).filter(s => s);
        }
        
        resume.sections.push({
          title: sectionName.charAt(0).toUpperCase() + sectionName.slice(1),
          content: content
        });
      }
      break;
  }
}

/**
 * Parse resume from file
 * @param {File} file - File object
 * @returns {Promise<Object>} Object with text and parsed data
 */
export async function parseResumeFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  
  let text = '';
  
  switch (extension) {
    case 'txt':
      text = await file.text();
      break;
      
    case 'pdf':
      text = await extractTextFromPdf(file);
      break;
      
    case 'docx':
      text = await extractTextFromDocx(file);
      break;
      
    default:
      throw new Error(`Unsupported file type: ${extension}`);
  }
  
  const parsed = parseResumeText(text);
  
  return { text, parsed };
}

/**
 * Extract text from PDF file
 * @param {File} file - PDF file
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  let text = '';
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    text += pageText + '\n';
  }
  
  return text;
}

/**
 * Extract text from DOCX file
 * @param {File} file - DOCX file
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromDocx(file) {
  // Dynamically import mammoth
  const mammoth = await import('mammoth');
  
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  
  return result.value;
}

/**
 * Clean and normalize extracted text
 * @param {string} text - Raw extracted text
 * @returns {string} Cleaned text
 */
export function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
