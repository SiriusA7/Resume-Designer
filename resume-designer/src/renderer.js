/**
 * Resume HTML Renderer
 * Converts parsed resume data into styled HTML with inline editing support
 */

function normalizeSectionType(type) {
  return type === 'skills' ? 'skills' : 'list';
}

function splitByBulletSeparators(line) {
  if (line === null || line === undefined) return [];
  return String(line)
    .split('•')
    .map(part => part.trim())
    .filter(Boolean);
}

function stripLeadingBulletMarker(text) {
  return text.replace(/^[\-*•]\s*/, '').trim();
}

function normalizeLineItems(line, mode) {
  const items = splitByBulletSeparators(line);
  if (mode === 'list') {
    return items.map(stripLeadingBulletMarker).filter(Boolean);
  }
  return items;
}

function formatInlineMarkdown(text) {
  const escaped = escapeHtmlRaw(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\+\+([^+\n]+)\+\+/g, '<u>$1</u>')
    .replace(/(^|[\s([{"'`])_([^_\n]+)_(?=$|[\s)\]}"'`.,!?;:])/g, '$1<em>$2</em>');
}

function formatListLine(line) {
  const items = normalizeLineItems(line, 'list');
  return items.map(item => `<span class="highlight-bullet">${formatInlineMarkdown(item)}</span>`).join('');
}

function formatSkillsLine(line) {
  const items = normalizeLineItems(line, 'skills');
  return items.map(item => `<span class="skill-tag">${formatInlineMarkdown(item)}</span>`).join('');
}

function formatSkillsLineStacked(line) {
  const items = normalizeLineItems(line, 'skills');
  return items
    .map(item => `<span class="skill-tag-inline">${formatInlineMarkdown(item)}</span>`)
    .join('<span class="skill-sep">•</span>');
}

function renderSectionLine(line, mode, variant = 'sidebar') {
  if (normalizeSectionType(mode) === 'list') {
    return formatListLine(line);
  }
  return variant === 'stacked' ? formatSkillsLineStacked(line) : formatSkillsLine(line);
}

function renderSectionContent(section, sIdx, variant = 'sidebar') {
  const mode = normalizeSectionType(section?.type);
  return (section.content || [])
    .map((line, i) => `
      <p data-editable="sections[${sIdx}].content[${i}]">${renderSectionLine(line, mode, variant)}</p>
    `)
    .join('');
}

function renderClassicSectionContent(section, sIdx) {
  const mode = normalizeSectionType(section?.type);
  if (mode === 'list') {
    return (section.content || [])
      .map((line, i) => `<p class="highlight-item" data-editable="sections[${sIdx}].content[${i}]">${renderSectionLine(line, mode)}</p>`)
      .join('');
  }
  return (section.content || [])
    .map((line, i) => `<span class="classic-skill-item" data-editable="sections[${sIdx}].content[${i}]">${renderSectionLine(line, mode)}</span>`)
    .join('');
}

function renderCreativeSectionContent(section, sIdx) {
  const mode = normalizeSectionType(section?.type);
  if (mode === 'list') {
    return (section.content || [])
      .map((line, i) => `<p class="highlight-item" data-editable="sections[${sIdx}].content[${i}]">${renderSectionLine(line, mode)}</p>`)
      .join('');
  }
  return (section.content || [])
    .map((line, i) => `<span class="creative-item" data-editable="sections[${sIdx}].content[${i}]">${renderSectionLine(line, mode)}</span>`)
    .join('');
}

function splitSectionsByMode(sections = []) {
  const lists = [];
  const skills = [];

  sections.forEach((section, sIdx) => {
    if (normalizeSectionType(section?.type) === 'skills') {
      skills.push({ section, sIdx });
    } else {
      lists.push({ section, sIdx });
    }
  });

  return { lists, skills };
}

function normalizeTools(tools) {
  const raw = Array.isArray(tools) ? tools.join(' • ') : (tools || '');
  return splitByBulletSeparators(raw);
}

function renderToolsInline(tools, editablePath = null) {
  const tokens = normalizeTools(tools);
  if (tokens.length === 0) return '';
  const editableAttr = editablePath ? ` data-editable="${editablePath}"` : '';
  return `<span class="skill-tag-row">${tokens.map(token => `<span class="skill-tag tool-token"${editableAttr}>${formatInlineMarkdown(token)}</span>`).join('<span class="skill-sep">•</span>')}</span>`;
}

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

// Stacked Vertical layout - highlights above skills (not side-by-side)
export function renderResumeStackedVertical(data) {
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
    
    <div class="resume-body stacked-vertical-body">
      ${data.summary ? `
        <div class="section summary-section">
          <h2 class="section-title">Summary</h2>
          <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
        </div>
      ` : ''}
      
      ${renderStackedVerticalSections(data)}
      
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

// Helper to render sections vertically (highlights first, then skills)
function renderStackedVerticalSections(data) {
  let html = '';
  
  if (!data.sections || data.sections.length === 0) {
    if (data.tools) {
      html += `
        <div class="section stacked-vertical-section">
          <h3 class="section-title">Tools</h3>
          <div class="stacked-vertical-content">
            <p data-editable="tools">${formatSkillsLineStacked(data.tools)}</p>
          </div>
        </div>
      `;
    }
    return html;
  }
  
  const { lists, skills } = splitSectionsByMode(data.sections);
  
  // Render highlights first (full width)
  lists.forEach(({ section, sIdx }) => {
    html += `
      <div class="section stacked-vertical-section highlight-section" data-section-id="${section.id || sIdx}">
        <h2 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h2>
        <div class="stacked-vertical-content">
          ${renderSectionContent(section, sIdx, 'stacked')}
        </div>
      </div>
    `;
  });
  
  // Render skills below (full width)
  skills.forEach(({ section, sIdx }) => {
    html += `
      <div class="section stacked-vertical-section skill-section" data-section-id="${section.id || sIdx}">
        <h2 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h2>
        <div class="stacked-vertical-content">
          ${renderSectionContent(section, sIdx, 'stacked')}
        </div>
      </div>
    `;
  });
  
  // Add tools if present
  if (data.tools) {
    html += `
      <div class="section stacked-vertical-section">
        <h3 class="section-title">Tools</h3>
        <div class="stacked-vertical-content">
          <p data-editable="tools">${formatSkillsLineStacked(data.tools)}</p>
        </div>
      </div>
    `;
  }
  
  return html;
}

function renderContact(contact) {
  if (!contact) return '';
  
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
  if (!contact) return '';
  
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
        const sectionClass = normalizeSectionType(section?.type) === 'skills'
          ? 'stacked-skill-section'
          : 'stacked-skill-section highlight-section';
        html += `
          <div class="${sectionClass}" data-section-id="${section.id || sIdx}">
            <h3 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h3>
            <div class="stacked-skill-content">
              ${renderSectionContent(section, sIdx, 'stacked')}
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
            <p data-editable="tools">${formatSkillsLineStacked(data.tools)}</p>
          </div>
        </div>
      `;
    }
    
    html += '</div>';
  }
  
  return html;
}

function renderSidebar(data) {
  let html = '';
  
  // Render sidebar sections
  if (data.sections) {
    for (let sIdx = 0; sIdx < data.sections.length; sIdx++) {
      const section = data.sections[sIdx];
      const mode = normalizeSectionType(section?.type);

      if (mode === 'list') {
        // Render as block-level bullets
        html += `
          <div class="sidebar-section" data-section-id="${section.id || sIdx}">
            <h3 class="sidebar-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h3>
            <div class="sidebar-content">
              ${renderSectionContent(section, sIdx)}
            </div>
          </div>
        `;
      } else {
        const allSkills = (section.content || [])
          .map((line, i) => {
            const rendered = renderSectionLine(line, 'skills');
            if (!rendered) return '';
            return `<span class="skill-tag-row" data-editable="sections[${sIdx}].content[${i}]">${rendered}</span>`;
          })
          .filter(Boolean)
          .join('<span class="skill-sep">•</span>');

        html += `
          <div class="sidebar-section" data-section-id="${section.id || sIdx}">
            <h3 class="sidebar-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h3>
            <div class="sidebar-content sidebar-skills">
              ${allSkills}
            </div>
          </div>
        `;
      }
    }
  }
  
  // Render tools - always render as inline skill tags
  if (data.tools) {
    const toolTags = renderToolsInline(data.tools, 'tools');
    
    html += `
      <div class="sidebar-section">
        <h3 class="sidebar-title">Tools</h3>
        <div class="sidebar-content sidebar-skills tools-list">
          ${toolTags}
        </div>
      </div>
    `;
  }
  
  return html;
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
  
  // If text already contains supported formatting tags, just return it
  // (data from parser already has HTML)
  if (
    text.includes('<strong>') || text.includes('</strong>') ||
    text.includes('<em>') || text.includes('</em>') ||
    text.includes('<u>') || text.includes('</u>')
  ) {
    return text;
  }

  return formatInlineMarkdown(text);
}

// HTML escape utility to prevent XSS
function escapeHtmlRaw(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeHtml(str) {
  return formatInlineMarkdown(str);
}

// Right Sidebar layout (sidebar on the right)
export function renderResumeRightSidebar(data) {
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
    
    <div class="resume-body right-sidebar-body">
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
      
      <aside class="resume-sidebar">
        ${renderSidebar(data)}
      </aside>
    </div>
  `;
}

// Compact layout (condensed spacing, smaller fonts)
export function renderResumeCompact(data) {
  return `
    <header class="resume-header compact-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
      </div>
      <div class="header-contact compact-contact">
        ${renderContactCompact(data.contact)}
      </div>
    </header>
    
    <div class="resume-body compact-body">
      <div class="compact-columns">
        <section class="compact-main">
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
        </section>
        
        <aside class="compact-sidebar">
          ${renderSidebar(data)}
          
          ${data.education && data.education.length > 0 ? `
            <div class="sidebar-section">
              <h3 class="sidebar-title">Education</h3>
              <div class="sidebar-content">
                ${data.education.map((line, i) => `
                  <p data-editable="education[${i}]">${escapeHtml(line)}</p>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </aside>
      </div>
    </div>
  `;
}

// Compact contact renderer (inline)
function renderContactCompact(contact) {
  if (!contact) return '';
  contact = contact || {};
  const items = [];
  
  if (contact.location) items.push(contact.location);
  if (contact.email) items.push(`<a href="mailto:${contact.email}" class="contact-item">${contact.email}</a>`);
  if (contact.phone) items.push(`<a href="tel:${contact.phone}" class="contact-item">${contact.phone}</a>`);
  if (contact.portfolio) items.push(`<a href="${contact.portfolio}" class="contact-item" target="_blank">${formatUrl(contact.portfolio)}</a>`);
  
  return `<div class="compact-contact-row">${items.join(' <span class="contact-sep">•</span> ')}</div>`;
}

// Executive layout (centered, spacious)
export function renderResumeExecutive(data) {
  return `
    <header class="resume-header executive-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
      </div>
      <div class="header-contact executive-contact">
        ${renderContactStacked(data.contact)}
      </div>
    </header>
    
    <div class="resume-body executive-body">
      ${data.summary ? `
        <div class="section summary-section executive-summary">
          <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
        </div>
      ` : ''}
      
      <div class="executive-columns">
        <div class="executive-main">
          ${data.experience && data.experience.length > 0 ? `
            <div class="section experience-section">
              <h2 class="section-title">Professional Experience</h2>
              ${data.experience.map((exp, i) => renderExperience(exp, i)).join('')}
            </div>
          ` : ''}
        </div>
        
        <div class="executive-side">
          ${renderSidebar(data)}
          
          ${data.education && data.education.length > 0 ? `
            <div class="sidebar-section">
              <h3 class="sidebar-title">Education</h3>
              <div class="sidebar-content">
                ${data.education.map((line, i) => `
                  <p data-editable="education[${i}]">${escapeHtml(line)}</p>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// Classic layout (traditional single column)
export function renderResumeClassic(data) {
  return `
    <header class="resume-header classic-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
        <div class="classic-contact">
          ${renderContactClassic(data.contact)}
        </div>
      </div>
    </header>
    
    <div class="resume-body classic-body">
      ${data.summary ? `
        <div class="section summary-section">
          <h2 class="section-title">Professional Summary</h2>
          <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
        </div>
      ` : ''}
      
      ${data.experience && data.experience.length > 0 ? `
        <div class="section experience-section">
          <h2 class="section-title">Professional Experience</h2>
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
      
      ${data.sections && data.sections.length > 0 ? `
        <div class="classic-skills-section">
          ${data.sections.map((section, sIdx) => `
            <div class="section">
              <h2 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h2>
              <div class="classic-skill-content">
                ${renderClassicSectionContent(section, sIdx)}
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// Classic Featured layout - highlights after summary, skills at bottom
export function renderResumeClassicFeatured(data) {
  const { lists: highlights, skills } = splitSectionsByMode(data.sections || []);
  
  return `
    <header class="resume-header classic-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
        <div class="classic-contact">
          ${renderContactClassic(data.contact)}
        </div>
      </div>
    </header>
    
    <div class="resume-body classic-featured-body">
      ${data.summary ? `
        <div class="section summary-section">
          <h2 class="section-title">Professional Summary</h2>
          <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
        </div>
      ` : ''}
      
      ${highlights.length > 0 ? `
        <div class="classic-featured-highlights">
          ${highlights.map(({ section, sIdx }) => `
            <div class="section highlight-section">
              <h2 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h2>
              <div class="classic-featured-highlight-content">
                ${renderClassicSectionContent(section, sIdx)}
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      
      ${data.experience && data.experience.length > 0 ? `
        <div class="section experience-section">
          <h2 class="section-title">Professional Experience</h2>
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
      
      ${skills.length > 0 ? `
        <div class="classic-skills-section">
          ${skills.map(({ section, sIdx }) => `
            <div class="section">
              <h2 class="section-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h2>
              <div class="classic-skill-content">
                ${renderClassicSectionContent(section, sIdx)}
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// Classic contact renderer
function renderContactClassic(contact) {
  if (!contact) return '';
  contact = contact || {};
  const items = [];
  
  if (contact.location) items.push(`<span class="contact-item">${contact.location}</span>`);
  if (contact.email) items.push(`<a href="mailto:${contact.email}" class="contact-item">${contact.email}</a>`);
  if (contact.phone) items.push(`<a href="tel:${contact.phone}" class="contact-item">${contact.phone}</a>`);
  if (contact.portfolio) items.push(`<a href="${contact.portfolio}" class="contact-item" target="_blank">${formatUrl(contact.portfolio)}</a>`);
  if (contact.linkedin) items.push(`<a href="${contact.linkedin}" class="contact-item" target="_blank">${formatUrl(contact.linkedin)}</a>`);
  
  return items.join(' <span class="contact-sep">|</span> ');
}

// Format URL helper
function formatUrl(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// Modern layout (slim sidebar, header on top)
export function renderResumeModern(data) {
  return `
    <header class="resume-header modern-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
      </div>
      <div class="header-contact modern-contact">
        ${renderContactModern(data.contact)}
      </div>
    </header>
    
    <div class="resume-body modern-body">
      <aside class="resume-sidebar modern-sidebar">
        ${renderSidebar(data)}
        
        ${data.education && data.education.length > 0 ? `
          <div class="sidebar-section">
            <h3 class="sidebar-title">Education</h3>
            <div class="education-content">
              ${data.education.map((line, i) => `
                <p data-editable="education[${i}]">${escapeHtml(line)}</p>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </aside>
      
      <main class="resume-main modern-main">
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
      </main>
    </div>
  `;
}

// Modern contact renderer
function renderContactModern(contact) {
  if (!contact) return '';
  contact = contact || {};
  const items = [];
  
  if (contact.email) items.push(`<a href="mailto:${contact.email}" class="contact-item">${contact.email}</a>`);
  if (contact.phone) items.push(`<a href="tel:${contact.phone}" class="contact-item">${contact.phone}</a>`);
  if (contact.portfolio) items.push(`<a href="${contact.portfolio}" class="contact-item" target="_blank">${formatUrl(contact.portfolio)}</a>`);
  
  return items.join(' <span class="contact-sep">•</span> ');
}

// Timeline layout (visual timeline for experience)
export function renderResumeTimeline(data) {
  return `
    <header class="resume-header timeline-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
      </div>
      <div class="header-contact">
        ${renderContact(data.contact)}
      </div>
    </header>
    
    <div class="resume-body timeline-body">
      <main class="resume-main timeline-main">
        ${data.summary ? `
          <div class="section summary-section">
            <h2 class="section-title">Summary</h2>
            <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
          </div>
        ` : ''}
        
        ${data.experience && data.experience.length > 0 ? `
          <div class="section experience-section timeline-experience">
            <h2 class="section-title">Experience</h2>
            <div class="timeline-container">
              ${data.experience.map((exp, i) => renderTimelineExperience(exp, i)).join('')}
            </div>
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
      </main>
      
      <aside class="resume-sidebar timeline-sidebar">
        ${renderSidebar(data)}
      </aside>
    </div>
  `;
}

// Timeline experience renderer with visual timeline
function renderTimelineExperience(exp, index) {
  return `
    <div class="timeline-item">
      <div class="timeline-marker">
        <span class="timeline-dot"></span>
        <span class="timeline-line"></span>
      </div>
      <div class="timeline-content">
        <div class="experience-header">
          <div class="experience-title-row">
            <span class="experience-title" data-editable="experience[${index}].title">${escapeHtml(exp.title)}</span>
            ${exp.company ? `<span class="experience-company" data-editable="experience[${index}].company">${escapeHtml(exp.company)}</span>` : ''}
          </div>
          <span class="experience-dates" data-editable="experience[${index}].dates">${escapeHtml(exp.dates)}</span>
        </div>
        ${exp.bullets && exp.bullets.length > 0 ? `
          <ul class="experience-bullets">
            ${exp.bullets.map((bullet, bIdx) => `
              <li data-editable="experience[${index}].bullets[${bIdx}]">${formatBullet(bullet)}</li>
            `).join('')}
          </ul>
        ` : ''}
      </div>
    </div>
  `;
}

// Creative layout (multi-column grid for skills/highlights)
export function renderResumeCreative(data) {
  return `
    <header class="resume-header creative-header">
      <div class="header-main">
        <h1 class="resume-name" data-editable="name">${escapeHtml(data.name)}</h1>
        <p class="resume-tagline" data-editable="tagline">${escapeHtml(data.tagline)}</p>
        <div class="creative-contact">
          ${renderContactCreative(data.contact)}
        </div>
      </div>
    </header>
    
    <div class="resume-body creative-body">
      ${data.summary ? `
        <div class="section summary-section creative-summary">
          <p class="summary-text" data-editable="summary" data-multiline="true">${escapeHtml(data.summary)}</p>
        </div>
      ` : ''}
      
      ${data.sections && data.sections.length > 0 ? `
        <div class="creative-grid">
          ${data.sections.map((section, sIdx) => `
            <div class="creative-card">
              <h3 class="creative-card-title" data-editable="sections[${sIdx}].title">${escapeHtml(section.title)}</h3>
              <div class="creative-card-content">
                ${renderCreativeSectionContent(section, sIdx)}
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      
      ${data.experience && data.experience.length > 0 ? `
        <div class="section experience-section creative-experience">
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

// Creative contact renderer
function renderContactCreative(contact) {
  if (!contact) return '';
  contact = contact || {};
  const items = [];
  
  if (contact.email) items.push(`<a href="mailto:${contact.email}" class="contact-item">${contact.email}</a>`);
  if (contact.phone) items.push(`<a href="tel:${contact.phone}" class="contact-item">${contact.phone}</a>`);
  if (contact.location) items.push(`<span class="contact-item">${contact.location}</span>`);
  if (contact.portfolio) items.push(`<a href="${contact.portfolio}" class="contact-item" target="_blank">${formatUrl(contact.portfolio)}</a>`);
  
  return items.join(' <span class="contact-sep">•</span> ');
}
