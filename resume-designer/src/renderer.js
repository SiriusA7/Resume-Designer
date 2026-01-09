/**
 * Resume HTML Renderer
 * Converts parsed resume data into styled HTML
 */

// Sidebar layout (default)
export function renderResume(data) {
  return `
    <header class="resume-header">
      <div class="header-main">
        <h1 class="resume-name">${data.name}</h1>
        <p class="resume-tagline">${data.tagline}</p>
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
            <p class="summary-text">${data.summary}</p>
          </div>
        ` : ''}
        
        ${data.experience.length > 0 ? `
          <div class="section experience-section">
            <h2 class="section-title">Experience</h2>
            ${data.experience.map(renderExperience).join('')}
          </div>
        ` : ''}
        
        ${data.education.length > 0 ? `
          <div class="section education-section">
            <h2 class="section-title">Education</h2>
            <div class="education-content">
              ${data.education.map(line => `<p>${line}</p>`).join('')}
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
        <h1 class="resume-name">${data.name}</h1>
        <p class="resume-tagline">${data.tagline}</p>
      </div>
      <div class="header-contact stacked-contact">
        ${renderContactStacked(data.contact)}
      </div>
    </header>
    
    <div class="resume-body stacked-body">
      ${data.summary ? `
        <div class="section summary-section">
          <h2 class="section-title">Summary</h2>
          <p class="summary-text">${data.summary}</p>
        </div>
      ` : ''}
      
      ${renderStackedSections(data)}
      
      ${data.experience.length > 0 ? `
        <div class="section experience-section">
          <h2 class="section-title">Experience</h2>
          ${data.experience.map(renderExperience).join('')}
        </div>
      ` : ''}
      
      ${data.education.length > 0 ? `
        <div class="section education-section">
          <h2 class="section-title">Education</h2>
          <div class="education-content">
            ${data.education.map(line => `<p>${line}</p>`).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderContact(contact) {
  const items = [];
  
  if (contact.location) {
    items.push(`<span class="contact-item location">${contact.location}</span>`);
  }
  if (contact.email) {
    items.push(`<a href="mailto:${contact.email}" class="contact-item email">${contact.email}</a>`);
  }
  if (contact.phone) {
    items.push(`<a href="tel:${contact.phone.replace(/-/g, '')}" class="contact-item phone">${contact.phone}</a>`);
  }
  if (contact.portfolio) {
    items.push(`<a href="https://${contact.portfolio}" target="_blank" class="contact-item portfolio">${contact.portfolio}</a>`);
  }
  if (contact.instagram) {
    items.push(`<a href="https://instagram.com/${contact.instagram.replace('@', '')}" target="_blank" class="contact-item instagram">${contact.instagram}</a>`);
  }
  
  return items.join('');
}

function renderContactStacked(contact) {
  const items = [];
  
  if (contact.email) {
    items.push(`<a href="mailto:${contact.email}" class="contact-item email">${contact.email}</a>`);
  }
  if (contact.phone) {
    items.push(`<a href="tel:${contact.phone.replace(/-/g, '')}" class="contact-item phone">${contact.phone}</a>`);
  }
  if (contact.portfolio) {
    items.push(`<a href="https://${contact.portfolio}" target="_blank" class="contact-item portfolio">${contact.portfolio}</a>`);
  }
  if (contact.instagram) {
    items.push(`<a href="https://instagram.com/${contact.instagram.replace('@', '')}" target="_blank" class="contact-item instagram">${contact.instagram}</a>`);
  }
  
  let html = '';
  if (contact.location) {
    html += `<span class="contact-item location">${contact.location}</span>`;
  }
  if (items.length > 0) {
    html += `<div class="contact-row">${items.join('<span class="contact-sep">•</span>')}</div>`;
  }
  
  return html;
}

function renderStackedSections(data) {
  let html = '';
  
  // Render skill sections in a grid for stacked layout
  if (data.sections.length > 0 || data.tools) {
    html += '<div class="stacked-skills-grid">';
    
    for (const section of data.sections) {
      html += `
        <div class="stacked-skill-section">
          <h3 class="section-title">${section.title}</h3>
          <div class="stacked-skill-content">
            ${section.content.map(line => `<p>${formatSkillLineStacked(line)}</p>`).join('')}
          </div>
        </div>
      `;
    }
    
    if (data.tools) {
      html += `
        <div class="stacked-skill-section">
          <h3 class="section-title">Tools</h3>
          <div class="stacked-skill-content tools-list">
            <p>${formatSkillLineStacked(data.tools)}</p>
          </div>
        </div>
      `;
    }
    
    html += '</div>';
  }
  
  return html;
}

function formatSkillLineStacked(line) {
  // Handle bullet point lines (from Highlights sections)
  if (line.startsWith('- ')) {
    const content = line.substring(2).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return `<span class="highlight-bullet">${content}</span>`;
  }
  
  // Convert **text** to <strong>text</strong>
  const formatted = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Convert bullet separators to styled inline elements
  return formatted.split('•').map(skill => 
    `<span class="skill-tag-inline">${skill.trim()}</span>`
  ).join('<span class="skill-sep">•</span>');
}

function renderSidebar(data) {
  let html = '';
  
  // Render skill sections
  for (const section of data.sections) {
    html += `
      <div class="sidebar-section">
        <h3 class="sidebar-title">${section.title}</h3>
        <div class="sidebar-content">
          ${section.content.map(line => `<p>${formatSkillLine(line)}</p>`).join('')}
        </div>
      </div>
    `;
  }
  
  // Render tools
  if (data.tools) {
    html += `
      <div class="sidebar-section">
        <h3 class="sidebar-title">Tools</h3>
        <div class="sidebar-content tools-list">
          <p>${formatSkillLine(data.tools)}</p>
        </div>
      </div>
    `;
  }
  
  return html;
}

function formatSkillLine(line) {
  // Handle bullet point lines (from Highlights sections)
  if (line.startsWith('- ')) {
    const content = line.substring(2).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return `<span class="highlight-bullet">${content}</span>`;
  }
  
  // Convert **text** to <strong>text</strong>
  const formatted = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Convert bullet separators to styled elements
  return formatted.split('•').map(skill => 
    `<span class="skill-tag">${skill.trim()}</span>`
  ).join('');
}

function renderExperience(exp) {
  return `
    <article class="experience-item">
      <div class="experience-header">
        <h3 class="experience-title">${exp.title}</h3>
        ${exp.company ? `<span class="experience-company">${exp.company}</span>` : ''}
      </div>
      <time class="experience-dates">${exp.dates}</time>
      ${exp.bullets.length > 0 ? `
        <ul class="experience-bullets">
          ${exp.bullets.map(bullet => `<li>${bullet}</li>`).join('')}
        </ul>
      ` : ''}
    </article>
  `;
}
