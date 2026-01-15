/**
 * Photo Service
 * Handles profile photo upload, placement, and styling
 */

// Photo placement options
export const PHOTO_PLACEMENTS = {
  'header': { name: 'Header', description: 'In the header area' },
  'sidebar-top': { name: 'Sidebar Top', description: 'Top of sidebar' },
  'floating': { name: 'Floating', description: 'Corner overlay' },
  'none': { name: 'Hidden', description: 'No photo shown' }
};

// Photo shape options
export const PHOTO_SHAPES = {
  'circle': { name: 'Circle', css: '50%' },
  'square': { name: 'Square', css: '0' },
  'rounded': { name: 'Rounded', css: '8px' },
  'rounded-lg': { name: 'More Rounded', css: '16px' }
};

// Photo size options (in pixels)
export const PHOTO_SIZES = {
  'small': { name: 'Small', value: 60 },
  'medium': { name: 'Medium', value: 80 },
  'large': { name: 'Large', value: 100 }
};

// Default photo settings
const DEFAULT_PHOTO = {
  enabled: false,
  imageData: null,  // base64 image data
  placement: 'header',
  shape: 'circle',
  size: 'medium',
  borderWidth: 2,
  borderColor: 'accent', // 'accent', 'white', 'none'
  objectPosition: 'center center', // focus point for cropping
  scale: 1 // zoom level (1 = 100%, 1.5 = 150%)
};

// Get current photo settings
export function getPhotoSettings() {
  const stored = localStorage.getItem('resume-photo-settings');
  if (stored) {
    try {
      return { ...DEFAULT_PHOTO, ...JSON.parse(stored) };
    } catch (e) {
      console.warn('Failed to parse photo settings:', e);
    }
  }
  return { ...DEFAULT_PHOTO };
}

// Save photo settings
export function savePhotoSettings(settings) {
  localStorage.setItem('resume-photo-settings', JSON.stringify(settings));
}

/**
 * Apply photo to the resume
 * @param {Object} settings - Photo settings object
 */
export function applyPhotoSettings(settings) {
  const resume = document.querySelector('.resume');
  if (!resume) return;
  
  const s = { ...DEFAULT_PHOTO, ...settings };
  
  // Remove existing photo element
  const existingPhoto = resume.querySelector('.resume-photo-container');
  if (existingPhoto) {
    existingPhoto.remove();
  }
  
  // Remove photo-related classes
  resume.classList.remove('has-photo', 'photo-header', 'photo-sidebar', 'photo-floating');
  
  if (!s.enabled || !s.imageData) {
    return;
  }
  
  // Add photo container
  const photoContainer = document.createElement('div');
  photoContainer.className = `resume-photo-container photo-placement-${s.placement}`;
  
  const size = PHOTO_SIZES[s.size]?.value || 80;
  const borderRadius = PHOTO_SHAPES[s.shape]?.css || '50%';
  
  let borderStyle = 'none';
  if (s.borderColor === 'accent') {
    borderStyle = `${s.borderWidth}px solid var(--resume-accent)`;
  } else if (s.borderColor === 'white') {
    borderStyle = `${s.borderWidth}px solid white`;
  }
  
  const objectPosition = s.objectPosition || 'center center';
  const scale = s.scale || 1;
  
  photoContainer.innerHTML = `
    <div class="resume-photo-wrapper" style="
      width: ${size}px;
      height: ${size}px;
      border-radius: ${borderRadius};
      border: ${borderStyle};
      overflow: hidden;
    ">
      <img src="${s.imageData}" 
           alt="Profile photo" 
           class="resume-photo"
           style="
             width: ${100 * scale}%;
             height: ${100 * scale}%;
             object-fit: cover;
             object-position: ${objectPosition};
             transform: scale(1) translate(${scale > 1 ? '-' + ((scale - 1) * 50 / scale) + '%' : '0'}, ${scale > 1 ? '-' + ((scale - 1) * 50 / scale) + '%' : '0'});
           ">
    </div>
  `;
  
  // Insert based on placement
  const header = resume.querySelector('.resume-header');
  const sidebar = resume.querySelector('.resume-sidebar');
  const headerMain = resume.querySelector('.header-main');
  
  if (s.placement === 'header' && headerMain) {
    headerMain.insertBefore(photoContainer, headerMain.firstChild);
    resume.classList.add('has-photo', 'photo-header');
  } else if (s.placement === 'sidebar-top' && sidebar) {
    sidebar.insertBefore(photoContainer, sidebar.firstChild);
    resume.classList.add('has-photo', 'photo-sidebar');
  } else if (s.placement === 'floating' && header) {
    header.appendChild(photoContainer);
    resume.classList.add('has-photo', 'photo-floating');
  }
}

/**
 * Remove photo
 */
export function removePhoto() {
  const settings = { ...DEFAULT_PHOTO, enabled: false, imageData: null };
  savePhotoSettings(settings);
  applyPhotoSettings(settings);
  return settings;
}

/**
 * Initialize photo service
 */
export function initPhotoService() {
  const settings = getPhotoSettings();
  applyPhotoSettings(settings);
  return settings;
}

// Export defaults
export { DEFAULT_PHOTO };
