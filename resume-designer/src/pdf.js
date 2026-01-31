/**
 * PDF Export Utilities
 * Uses html2pdf.js for PDF generation with custom page sizes
 */

import { isElectron, saveFile } from './native.js';

let html2pdfModule = null;

// Dynamically import html2pdf.js (browser fallback)
async function loadHtml2Pdf() {
  if (!html2pdfModule) {
    const module = await import('html2pdf.js');
    html2pdfModule = module.default || module;
  }
  return html2pdfModule;
}

export function initPdfExport() {
  const downloadBtn = document.getElementById('download-pdf');
  
  downloadBtn.addEventListener('click', showPdfDialog);
  
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
  
  // Close dialog
  closePdfDialog();
  
  // Validate resume element exists
  if (!resumeEl) {
    console.error('PDF generation failed: Resume element not found');
    alert('Failed to generate PDF: Resume content not found.');
    return;
  }
  
  // Use custom filename or default
  const filename = customFilename ? 
    (customFilename.endsWith('.pdf') ? customFilename : `${customFilename}.pdf`) : 
    'Resume.pdf';
  
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
    // Use html2pdf.js for PDF generation (supports custom page sizes, preserves text)
    console.log('PDF Export: Using html2pdf.js...');
    await generatePdfWithHtml2Pdf(resumeEl, filename);
    
  } catch (error) {
    console.error('PDF generation failed:', error);
    alert(`Failed to generate PDF: ${error.message || 'Unknown error'}. Check the console for details.`);
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

// Generate PDF using html2pdf.js (preserves text for ATS compatibility)
async function generatePdfWithHtml2Pdf(resumeEl, filename) {
  // Load html2pdf library
  console.log('PDF Export: Loading html2pdf.js...');
  let html2pdf;
  try {
    html2pdf = await loadHtml2Pdf();
    console.log('PDF Export: html2pdf.js loaded successfully');
  } catch (loadError) {
    console.error('PDF Export: Failed to load html2pdf.js', loadError);
    throw new Error(`Failed to load PDF library: ${loadError.message}`);
  }
  
  // Get the resume's actual rendered dimensions
  const resumeWidth = resumeEl.offsetWidth;
  const resumeHeight = resumeEl.offsetHeight; // Use offsetHeight for more accurate measurement
  
  // Convert pixels to inches (96 DPI)
  const pageWidthInches = resumeWidth / 96;
  // Add a tiny buffer (0.01") to prevent content from spilling to next page
  const pageHeightInches = (resumeHeight / 96) + 0.01;
  
  console.log(`PDF Export: Resume dimensions - ${resumeWidth}px x ${resumeHeight}px (${pageWidthInches.toFixed(2)}" x ${pageHeightInches.toFixed(2)}")`);
  
  // html2canvas options for high quality output
  const options = {
    margin: 0,
    filename: filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { 
      scale: 2,                      // 2x scale for high quality
      useCORS: true,
      logging: false,
      allowTaint: true,
      foreignObjectRendering: false,
      removeContainer: true,
      backgroundColor: '#ffffff',
      imageTimeout: 0,
      height: resumeHeight,          // Explicitly set height to match element
      windowHeight: resumeHeight,
      ignoreElements: (element) => {
        const tag = element.tagName?.toLowerCase();
        return tag === 'script' || tag === 'noscript' || tag === 'iframe';
      }
    },
    jsPDF: { 
      unit: 'in', 
      format: [pageWidthInches, pageHeightInches],
      orientation: 'portrait'
    }
  };
  
  console.log('PDF Export: Starting PDF generation...');
  
  try {
    if (isElectron) {
      // In Electron: Generate as blob and use native save dialog
      const pdfBlob = await html2pdf().set(options).from(resumeEl).outputPdf('blob');
      console.log('PDF Export: PDF blob generated, opening save dialog...');
      
      const result = await saveFile(pdfBlob, filename, [
        { name: 'PDF Documents', extensions: ['pdf'] }
      ]);
      
      if (result.success) {
        console.log('PDF Export: PDF saved to:', result.filePath);
      } else if (result.canceled) {
        console.log('PDF Export: Save canceled by user');
      } else {
        throw new Error(result.error || 'Failed to save PDF file');
      }
    } else {
      // In browser: Direct download
      await html2pdf().set(options).from(resumeEl).save();
      console.log('PDF Export: PDF download initiated');
    }
  } catch (renderError) {
    console.error('PDF Export: Render failed', renderError);
    throw new Error(`PDF rendering failed: ${renderError.message}`);
  }
}
