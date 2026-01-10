/**
 * PDF Export Utilities
 * Handles PDF generation via html2pdf.js and print functionality
 */

let html2pdfModule = null;

// Dynamically import html2pdf.js
async function loadHtml2Pdf() {
  if (!html2pdfModule) {
    const module = await import('html2pdf.js');
    html2pdfModule = module.default || module;
  }
  return html2pdfModule;
}

export function initPdfExport() {
  const downloadBtn = document.getElementById('download-pdf');
  const printBtn = document.getElementById('print-resume');
  
  downloadBtn.addEventListener('click', showPdfDialog);
  printBtn.addEventListener('click', handlePrint);
  
  // Initialize the PDF dialog
  initPdfDialog();
}

// Initialize PDF download dialog
function initPdfDialog() {
  // Create modal if it doesn't exist
  if (!document.getElementById('pdf-dialog-overlay')) {
    const dialogHTML = `
      <div class="modal-overlay" id="pdf-dialog-overlay">
        <div class="modal pdf-dialog">
          <div class="modal-header">
            <h3 class="modal-title">Download PDF</h3>
            <button class="modal-close" id="pdf-dialog-close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="modal-content">
            <div class="form-group">
              <label class="form-label" for="pdf-filename">Filename</label>
              <div class="pdf-filename-wrapper">
                <input type="text" id="pdf-filename" class="form-input" placeholder="Resume">
                <span class="pdf-extension">.pdf</span>
              </div>
            </div>
            <div class="pdf-dialog-actions">
              <button class="btn btn-secondary" id="pdf-dialog-cancel">Cancel</button>
              <button class="btn btn-primary" id="pdf-dialog-download">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', dialogHTML);
    
    // Set up event listeners
    const overlay = document.getElementById('pdf-dialog-overlay');
    const closeBtn = document.getElementById('pdf-dialog-close');
    const cancelBtn = document.getElementById('pdf-dialog-cancel');
    const downloadBtn = document.getElementById('pdf-dialog-download');
    const filenameInput = document.getElementById('pdf-filename');
    
    closeBtn?.addEventListener('click', closePdfDialog);
    cancelBtn?.addEventListener('click', closePdfDialog);
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) closePdfDialog();
    });
    
    downloadBtn?.addEventListener('click', () => {
      handleDownloadPdf(filenameInput?.value);
    });
    
    filenameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleDownloadPdf(filenameInput?.value);
      } else if (e.key === 'Escape') {
        closePdfDialog();
      }
    });
  }
}

// Show the PDF dialog
function showPdfDialog() {
  const overlay = document.getElementById('pdf-dialog-overlay');
  const filenameInput = document.getElementById('pdf-filename');
  
  // Get the active variant name for default filename
  const variantDropdown = document.getElementById('variant-dropdown');
  const selectedLabel = variantDropdown?.querySelector('.dropdown-label')?.textContent || 'Resume';
  const defaultFilename = `Colleen-Sinclair-${selectedLabel.trim().replace(/\s+/g, '-')}`;
  
  if (filenameInput) {
    filenameInput.value = defaultFilename;
  }
  
  overlay?.classList.add('show');
  
  // Focus and select filename
  setTimeout(() => {
    filenameInput?.focus();
    filenameInput?.select();
  }, 100);
}

// Close the PDF dialog
function closePdfDialog() {
  const overlay = document.getElementById('pdf-dialog-overlay');
  overlay?.classList.remove('show');
}

async function handleDownloadPdf(customFilename) {
  const resumeEl = document.getElementById('resume');
  const downloadBtn = document.getElementById('pdf-dialog-download');
  
  // Close dialog
  closePdfDialog();
  
  // Show loading state on header button
  const headerBtn = document.getElementById('download-pdf');
  if (headerBtn) {
    headerBtn.disabled = true;
    headerBtn.innerHTML = `
      <svg class="spinner" width="18" height="18" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="60" stroke-dashoffset="20"/>
      </svg>
      Generating...
    `;
  }
  
  try {
    const html2pdf = await loadHtml2Pdf();
    
    // Use custom filename or default
    const filename = customFilename ? 
      (customFilename.endsWith('.pdf') ? customFilename : `${customFilename}.pdf`) : 
      'Resume.pdf';
    
    // Fixed width (8.5 inches), adaptive height based on content
    const pageWidthInches = 8.5;
    
    // Get actual content height
    const contentHeight = resumeEl.scrollHeight;
    const contentHeightInches = contentHeight / 96;
    
    // Use content height, but minimum of 11 inches (letter size)
    const pageHeightInches = Math.max(11, contentHeightInches);
    
    const options = {
      margin: 0,
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { 
        scale: 2,
        useCORS: true,
        letterRendering: true
      },
      jsPDF: { 
        unit: 'in', 
        format: [pageWidthInches, pageHeightInches],
        orientation: 'portrait'
      }
    };
    
    await html2pdf().set(options).from(resumeEl).save();
    
  } catch (error) {
    console.error('PDF generation failed:', error);
    alert('Failed to generate PDF. Please try the Print option instead.');
  } finally {
    // Restore button state
    if (headerBtn) {
      headerBtn.disabled = false;
      headerBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download PDF
      `;
    }
  }
}

function handlePrint() {
  window.print();
}
