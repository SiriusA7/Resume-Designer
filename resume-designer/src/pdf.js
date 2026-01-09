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
  
  downloadBtn.addEventListener('click', handleDownloadPdf);
  printBtn.addEventListener('click', handlePrint);
}

async function handleDownloadPdf() {
  const resumeEl = document.getElementById('resume');
  const btn = document.getElementById('download-pdf');
  
  // Show loading state
  btn.disabled = true;
  btn.innerHTML = `
    <svg class="spinner" width="18" height="18" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="60" stroke-dashoffset="20"/>
    </svg>
    Generating...
  `;
  
  try {
    const html2pdf = await loadHtml2Pdf();
    
    // Get the active variant name for filename
    const activeBtn = document.querySelector('.variant-btn.active');
    const variantName = activeBtn ? activeBtn.textContent.trim().replace(/\s+/g, '-') : 'Resume';
    const filename = `Colleen-Sinclair-${variantName}.pdf`;
    
    // Fixed width (8.5 inches), adaptive height based on content
    const pageWidthInches = 8.5;
    const pageWidthPx = pageWidthInches * 96;  // 816px
    
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
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Download PDF
    `;
  }
}

function handlePrint() {
  window.print();
}
