/**
 * Zoom Controls
 * Handles resume preview zoom in/out and fit-to-view functionality
 */

let currentZoom = 1;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

// Initialize zoom controls
export function initZoomControls() {
  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  const zoomFit = document.getElementById('zoom-fit');
  const zoomReset = document.getElementById('zoom-reset');
  const zoomLevel = document.getElementById('zoom-level');
  
  if (!zoomIn || !zoomOut || !zoomFit || !zoomReset) return;
  
  // Load saved zoom level
  const savedZoom = localStorage.getItem('resume-zoom');
  if (savedZoom) {
    currentZoom = parseFloat(savedZoom);
    applyZoom();
  }
  
  // Zoom in
  zoomIn.addEventListener('click', () => {
    setZoom(Math.min(currentZoom + ZOOM_STEP, MAX_ZOOM));
  });
  
  // Zoom out
  zoomOut.addEventListener('click', () => {
    setZoom(Math.max(currentZoom - ZOOM_STEP, MIN_ZOOM));
  });
  
  // Fit to view
  zoomFit.addEventListener('click', fitToView);
  
  // Reset to 100%
  zoomReset.addEventListener('click', () => {
    setZoom(1);
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Only if not editing text
    if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      setZoom(Math.min(currentZoom + ZOOM_STEP, MAX_ZOOM));
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      setZoom(Math.max(currentZoom - ZOOM_STEP, MIN_ZOOM));
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      setZoom(1);
    }
  });
  
  // Handle window resize for fit-to-view
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      // Re-apply current zoom on resize to maintain position
    }, 100);
  });
}

// Set zoom level
function setZoom(level) {
  currentZoom = Math.round(level * 100) / 100;
  applyZoom();
  saveZoom();
}

// Apply zoom to resume container
function applyZoom() {
  const container = document.getElementById('resume-container');
  const zoomLevel = document.getElementById('zoom-level');
  
  if (container) {
    container.style.transform = `scale(${currentZoom})`;
  }
  
  if (zoomLevel) {
    zoomLevel.textContent = `${Math.round(currentZoom * 100)}%`;
  }
  
  // Update button states
  updateButtonStates();
}

// Fit resume to available view space
function fitToView() {
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');
  
  if (!scroller || !container) return;
  
  // Get available space (subtract padding)
  const availableWidth = scroller.clientWidth - 64; // 32px padding on each side
  const availableHeight = scroller.clientHeight - 96; // 64px top + 32px bottom
  
  // Get resume size (at scale 1)
  const resumeWidth = 8.5 * 96; // 8.5 inches at 96 DPI
  const resumeHeight = container.scrollHeight / currentZoom || 11 * 96; // Use actual height or estimate
  
  // Calculate zoom to fit
  const widthZoom = availableWidth / resumeWidth;
  const heightZoom = availableHeight / resumeHeight;
  
  // Use the smaller zoom to ensure entire resume is visible
  const fitZoom = Math.min(widthZoom, heightZoom, MAX_ZOOM);
  
  setZoom(Math.max(fitZoom, MIN_ZOOM));
}

// Update button enabled/disabled states
function updateButtonStates() {
  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  
  if (zoomIn) {
    zoomIn.disabled = currentZoom >= MAX_ZOOM;
    zoomIn.style.opacity = currentZoom >= MAX_ZOOM ? '0.4' : '1';
  }
  
  if (zoomOut) {
    zoomOut.disabled = currentZoom <= MIN_ZOOM;
    zoomOut.style.opacity = currentZoom <= MIN_ZOOM ? '0.4' : '1';
  }
}

// Save zoom level to localStorage
function saveZoom() {
  localStorage.setItem('resume-zoom', currentZoom.toString());
}

// Get current zoom level (for external use)
export function getZoom() {
  return currentZoom;
}
