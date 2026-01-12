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
      repositionToolbar();
    }, 100);
  });
  
  // Watch for sidebar changes to reposition toolbar
  setupSidebarObserver();
  
  // Initial positioning
  repositionToolbar();
}

// Reposition toolbar to center of content area
export function repositionToolbar() {
  const toolbar = document.getElementById('zoom-controls');
  const editHint = document.getElementById('edit-hint');
  const chatPanel = document.getElementById('chat-panel');
  const structurePanel = document.getElementById('structure-panel');
  
  if (!toolbar) return;
  
  // Calculate content area bounds
  const chatOpen = chatPanel && !chatPanel.classList.contains('closed');
  const structureOpen = structurePanel && !structurePanel.classList.contains('closed');
  
  const leftOffset = chatOpen ? 320 : 0; // Chat panel width
  const rightOffset = structureOpen ? 360 : 0; // Structure panel width
  
  // Calculate center of available content area
  const viewportWidth = window.innerWidth;
  const contentWidth = viewportWidth - leftOffset - rightOffset;
  const centerX = leftOffset + (contentWidth / 2);
  
  // Position toolbar
  toolbar.style.left = `${centerX}px`;
  toolbar.style.transform = 'translateX(-50%)';
  
  // Also position edit hint if it exists
  if (editHint) {
    editHint.style.left = `${centerX}px`;
  }
}

// Set up observer to watch for sidebar class changes
function setupSidebarObserver() {
  const chatPanel = document.getElementById('chat-panel');
  const structurePanel = document.getElementById('structure-panel');
  
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class') {
        repositionToolbar();
      }
    });
  });
  
  const config = { attributes: true, attributeFilter: ['class'] };
  
  if (chatPanel) {
    observer.observe(chatPanel, config);
  }
  if (structurePanel) {
    observer.observe(structurePanel, config);
  }
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
  
  // Temporarily reset zoom to get true dimensions
  const previousZoom = currentZoom;
  container.style.transform = 'scale(1)';
  
  // Force reflow to get accurate measurements
  container.offsetHeight;
  
  // Get available space (subtract padding)
  const availableWidth = scroller.clientWidth - 64; // 32px padding on each side
  const availableHeight = scroller.clientHeight - 96; // 64px top + 32px bottom
  
  // Get resume size at scale 1
  const resumeWidth = 8.5 * 96; // 8.5 inches at 96 DPI
  const resumeHeight = container.scrollHeight || 11 * 96; // Now measured at scale 1
  
  // Calculate zoom to fit
  const widthZoom = availableWidth / resumeWidth;
  const heightZoom = availableHeight / resumeHeight;
  
  // Use the smaller zoom to ensure entire resume is visible
  const fitZoom = Math.min(widthZoom, heightZoom, MAX_ZOOM);
  
  // Apply the calculated zoom
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
