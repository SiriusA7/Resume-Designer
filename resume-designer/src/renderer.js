/**
 * Resume HTML Renderer
 * Converts parsed resume data into styled HTML with inline editing support
 */

// Sidebar layout (default)
export function renderResume(data) {
  return `
    <header class="resume-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
      </div>
      <div class="header-contact">
        ${renderContact(data.contact)}
      </div>
    </header>
    
    <div class="resume-body">
      <aside class="resume-sidebar">
        ${renderSidebar(data)}
      </aside>
      
      <section class="resume-main">
        ${data.summary ? `
          <div class="section summary-section">
            <h2 class="section-title">Summary</h2>
            <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
          </div>
        ` : ''}
        
        ${data.experience && data.experience.length > 0 ? `
          <div class="section experience-section">
            <h2 class="section-title">Experience</h2>
            ${data.experience.map((exp, i) => renderExperience(exp, i)).join('')}
          </div>
        ` : ''}
        
        ${data.education && data.education.length > 0 ? `
          <div class="section education-section">
            <h2 class="section-title">Education</h2>
            <div class="education-content">
              ${data.education.map((line, i) => `
                <p data-editable="education[${i}]">${escapeHtml(line)}</p>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </section>
    </div>
  `;
}

// Stacked layout (all content flows vertically)
export function renderResumeStacked(data) {
  return `
    <header class="resume-header stacked-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
      </div>
      <div class="header-contact stacked-contact">
        ${renderContactStacked(data.contact)}
      </div>
    </header>
    
    <div class="resume-body stacked-body">
      ${data.summary ? `
        <div class="section summary-section">
          <h2 class="section-title">Summary</h2>
          <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
        </div>
      ` : ''}
      
      ${renderStackedSections(data)}
      
      ${data.experience && data.experience.length > 0 ? `
        <div class="section experience-section">
          <h2 class="section-title">Experience</h2>
          ${data.experience.map((exp, i) => renderExperience(exp, i)).join('')}
        </div>
      ` : ''}
      
      ${data.education && data.education.length > 0 ? `
        <div class="section education-section">
          <h2 class="section-title">Education</h2>
          <div class="education-content">
            ${data.education.map((line, i) => `
              <p data-editable="education[${i}]">${escapeHtml(line)}</p>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderContact(contact) {
  const items = [];
  
  if (contact.location) {
    items.push(`<span class="contact-item location" data-editable="contact.location">${escapeHtml(contact.location)}</span>`);
  }
  if (contact.email) {
    items.push(`<span class="contact-item email" data-editable="contact.email">${escapeHtml(contact.email)}</span>`);
  }
  if (contact.phone) {
    items.push(`<span class="contact-item phone" data-editable="contact.phone">${escapeHtml(contact.phone)}</span>`);
  }
  if (contact.portfolio) {
    items.push(`<span class="contact-item portfolio" data-editable="contact.portfolio">${escapeHtml(contact.portfolio)}</span>`);
  }
  if (contact.instagram) {
    items.push(`<span class="contact-item instagram" data-editable="contact.instagram">${escapeHtml(contact.instagram)}</span>`);
  }
  
  return items.join('');
}

function renderContactStacked(contact) {
  const items = [];
  
  if (contact.email) {
    items.push(`<span class="contact-item email" data-editable="contact.email">${escapeHtml(contact.email)}</span>`);
  }
  if (contact.phone) {
    items.push(`<span class="contact-item phone" data-editable="contact.phone">${escapeHtml(contact.phone)}</span>`);
  }
  if (contact.portfolio) {
    items.push(`<span class="contact-item portfolio" data-editable="contact.portfolio">${escapeHtml(contact.portfolio)}</span>`);
  }
  if (contact.instagram) {
    items.push(`<span class="contact-item instagram" data-editable="contact.instagram">${escapeHtml(contact.instagram)}</span>`);
  }
  
  let html = '';
  if (contact.location) {
    html += `<span class="contact-item location" data-editable="contact.location">${escapeHtml(contact.location)}</span>`;
  }
  if (items.length > 0) {
    html += `<div class="contact-row">${items.join('<span class="contact-sep">•</span>')}</div>`;
  }
  
  return html;
}

function renderStackedSections(data) {
  let html = '';
  
  // Render skill sections in a grid for stacked layout
  if ((data.sections && data.sections.length > 0) || data.tools) {
    html += '<div class="stacked-skills-grid">';
    
    if (data.sections) {
      for (let sIdx = 0; sIdx < data.sections.length; sIdx++) {
        const section = data.sections[sIdx];
        html += `
          <div class="stacked-skill-section" data-section-id="${section.id || sIdx}">
            <h3 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h3>
            <div class="stacked-skill-content">
              ${section.content.map((line, i) => `
                <p data-editable="sections[${sIdx}].content[${i}]">${formatSkillLineStacked(line)}</p>
              `).join('')}
            </div>
          </div>
        `;
      }
    }
    
    if (data.tools) {
      html += `
        <div class="stacked-skill-section">
          <h3 class="section-title">Tools</h3>
          <div class="stacked-skill-content tools-list">
            <p data-editable="tools">${formatSkillLineStacked(data.tools)}</p>
          </div>
        </div>
      `;
    }
    
    html += '</div>';
  }
  
  return html;
}

function formatSkillLineStacked(line) {
  if (!line) return '';
  
  // Handle bullet point lines (from Highlights sections)
  if (line.startsWith('- ')) {
    const content = line.substring(2).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return `<span class="highlight-bullet">${content}</span>`;
  }
  
  // Convert **text** to <strong>text</strong>
  const formatted = escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Convert bullet separators to styled inline elements
  return formatted.split('•').map(skill => 
    `<span class="skill-tag-inline">${skill.trim()}</span>`
  ).join('<span class="skill-sep">•</span>');
}

function renderSidebar(data) {
  let html = '';
  
  // Render skill sections
  if (data.sections) {
    for (let sIdx = 0; sIdx < data.sections.length; sIdx++) {
      const section = data.sections[sIdx];
      html += `
        <div class="sidebar-section" data-section-id="${section.id || sIdx}">
          <h3 class="sidebar-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h3>
          <div class="sidebar-content">
            ${section.content.map((line, i) => `
              <p data-editable="sections[${sIdx}].content[${i}]">${formatSkillLine(line)}</p>
            `).join('')}
          </div>
        </div>
      `;
    }
  }
  
  // Render tools
  if (data.tools) {
    html += `
      <div class="sidebar-section">
        <h3 class="sidebar-title">Tools</h3>
        <div class="sidebar-content tools-list">
          <p data-editable="tools">${formatSkillLine(data.tools)}</p>
        </div>
      </div>
    `;
  }
  
  return html;
}

function formatSkillLine(line) {
  if (!line) return '';
  
  // Handle bullet point lines (from Highlights sections)
  if (line.startsWith('- ')) {
    const content = line.substring(2).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return `<span class="highlight-bullet">${content}</span>`;
  }
  
  // Convert **text** to <strong>text</strong>
  const formatted = escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Convert bullet separators to styled elements
  return formatted.split('•').map(skill => 
    `<span class="skill-tag">${skill.trim()}</span>`
  ).join('');
}

function renderExperience(exp, index) {
  return `
    <article class="experience-item" data-experience-id="${exp.id || index}">
      <div class="experience-header">
        <h3 class="experience-title" data-editable="experience[${index}].title">${escapeHtml(exp.title)}</h3>
        ${exp.company ? `<span class="experience-company" data-editable="experience[${index}].company">${escapeHtml(exp.company)}</span>` : ''}
      </div>
      <time class="experience-dates" data-editable="experience[${index}].dates">${escapeHtml(exp.dates)}</time>
      ${exp.bullets && exp.bullets.length > 0 ? `
        <ul class="experience-bullets">
          ${exp.bullets.map((bullet, i) => `
            <li data-editable="experience[${index}].bullets[${i}]">${formatBullet(bullet)}</li>
          `).join('')}
        </ul>
      ` : ''}
    </article>
  `;
}

// Format bullet text - handle both raw markdown and pre-converted HTML
function formatBullet(text) {
  if (!text) return '';
  
  // If text already contains HTML strong tags, just return it
  // (data from parser already has HTML)
  if (text.includes('<strong>') || text.includes('</strong>')) {
    return text;
  }
  
  // Otherwise, convert markdown bold to HTML
  // First escape any dangerous characters, then convert **text** to <strong>
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// HTML escape utility to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
