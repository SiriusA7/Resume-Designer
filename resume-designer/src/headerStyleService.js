/**
 * Header Style Service
 * Handles header background styles including gradients, patterns, textures, and custom images
 */

// Gradient style definitions
export const GRADIENT_STYLES = {
  'linear-135': {
    name: 'Diagonal',
    css: (color1, color2) => `linear-gradient(135deg, ${color1} 0%, ${color2} 100%)`
  },
  'linear-180': {
    name: 'Vertical',
    css: (color1, color2) => `linear-gradient(180deg, ${color1} 0%, ${color2} 100%)`
  },
  'linear-90': {
    name: 'Horizontal',
    css: (color1, color2) => `linear-gradient(90deg, ${color1} 0%, ${color2} 100%)`
  },
  'linear-45': {
    name: 'Diagonal Up',
    css: (color1, color2) => `linear-gradient(45deg, ${color1} 0%, ${color2} 100%)`
  },
  'radial-center': {
    name: 'Radial Center',
    css: (color1, color2) => `radial-gradient(circle at center, ${color2} 0%, ${color1} 100%)`
  },
  'radial-corner': {
    name: 'Corner Spotlight',
    css: (color1, color2) => `radial-gradient(circle at top right, ${color2} 0%, ${color1} 70%)`
  },
  'mesh': {
    name: 'Mesh',
    css: (color1, color2) => `
      linear-gradient(135deg, ${color1} 0%, transparent 50%),
      linear-gradient(225deg, ${color2} 0%, transparent 50%),
      linear-gradient(45deg, ${adjustBrightness(color1, 0.1)} 0%, transparent 50%),
      ${color1}
    `
  }
};

// Pattern definitions using CSS/SVG backgrounds
export const PATTERN_STYLES = {
  'dots': {
    name: 'Dots',
    css: (color1, color2, accentColor) => `
      radial-gradient(${accentColor}15 2px, transparent 2px),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: '20px 20px',
    position: '0 0'
  },
  'dots-dense': {
    name: 'Dense Dots',
    css: (color1, color2, accentColor) => `
      radial-gradient(${accentColor}20 1.5px, transparent 1.5px),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: '12px 12px',
    position: '0 0'
  },
  'diagonal-lines': {
    name: 'Diagonal Lines',
    css: (color1, color2, accentColor) => `
      repeating-linear-gradient(
        45deg,
        transparent,
        transparent 10px,
        ${accentColor}10 10px,
        ${accentColor}10 12px
      ),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: 'auto',
    position: '0 0'
  },
  'horizontal-lines': {
    name: 'Horizontal Lines',
    css: (color1, color2, accentColor) => `
      repeating-linear-gradient(
        0deg,
        transparent,
        transparent 8px,
        ${accentColor}08 8px,
        ${accentColor}08 9px
      ),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: 'auto',
    position: '0 0'
  },
  'grid': {
    name: 'Grid',
    css: (color1, color2, accentColor) => `
      linear-gradient(${accentColor}10 1px, transparent 1px),
      linear-gradient(90deg, ${accentColor}10 1px, transparent 1px),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: '24px 24px, 24px 24px, auto',
    position: '0 0'
  },
  'chevron': {
    name: 'Chevron',
    css: (color1, color2, accentColor) => `
      linear-gradient(135deg, ${accentColor}08 25%, transparent 25%),
      linear-gradient(225deg, ${accentColor}08 25%, transparent 25%),
      linear-gradient(45deg, ${accentColor}08 25%, transparent 25%),
      linear-gradient(315deg, ${accentColor}08 25%, transparent 25%),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: '40px 40px, 40px 40px, 40px 40px, 40px 40px, auto',
    position: '0 0, 20px 0, 20px -20px, 0 20px, 0 0'
  },
  'triangles': {
    name: 'Triangles',
    css: (color1, color2, accentColor) => `
      linear-gradient(135deg, ${accentColor}12 25%, transparent 25%),
      linear-gradient(225deg, ${accentColor}08 25%, transparent 25%),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: '60px 60px, 60px 60px, auto',
    position: '0 0, 30px 30px, 0 0'
  },
  'topographic': {
    name: 'Topographic',
    css: (color1, color2, accentColor) => `
      repeating-radial-gradient(
        circle at 50% 50%,
        transparent 0px,
        transparent 10px,
        ${accentColor}08 10px,
        ${accentColor}08 11px
      ),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: 'auto',
    position: '0 0'
  },
  'waves': {
    name: 'Waves',
    css: (color1, color2, accentColor) => `
      radial-gradient(ellipse at 0% 50%, ${accentColor}15 0%, transparent 50%),
      radial-gradient(ellipse at 100% 50%, ${accentColor}10 0%, transparent 50%),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    size: 'auto',
    position: '0 0'
  }
};

// Texture definitions
export const TEXTURE_STYLES = {
  'noise': {
    name: 'Noise',
    overlay: true,
    css: (color1, color2) => `
      url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E"),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    blendMode: 'overlay',
    opacity: 0.15
  },
  'paper': {
    name: 'Paper',
    overlay: true,
    css: (color1, color2) => `
      url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='paper'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.04' numOctaves='5'/%3E%3CfeDiffuseLighting lighting-color='%23fff' surfaceScale='2'%3E%3CfeDistantLight azimuth='45' elevation='60'/%3E%3C/feDiffuseLighting%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23paper)'/%3E%3C/svg%3E"),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    blendMode: 'multiply',
    opacity: 0.08
  },
  'grain': {
    name: 'Fine Grain',
    overlay: true,
    css: (color1, color2) => `
      url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='grain'%3E%3CfeTurbulence type='turbulence' baseFrequency='0.7' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23grain)'/%3E%3C/svg%3E"),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    blendMode: 'overlay',
    opacity: 0.1
  },
  'fabric': {
    name: 'Fabric',
    overlay: false,
    css: (color1, color2, accentColor) => `
      repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        ${accentColor}05 2px,
        ${accentColor}05 3px
      ),
      repeating-linear-gradient(
        90deg,
        transparent,
        transparent 2px,
        ${accentColor}05 2px,
        ${accentColor}05 3px
      ),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    blendMode: 'normal',
    opacity: 1
  },
  'watercolor': {
    name: 'Watercolor',
    overlay: false,
    css: (color1, color2, accentColor) => `
      radial-gradient(ellipse at 20% 80%, ${adjustBrightness(accentColor, 0.2)}40 0%, transparent 50%),
      radial-gradient(ellipse at 80% 20%, ${adjustBrightness(color2, 0.3)}30 0%, transparent 60%),
      radial-gradient(ellipse at 60% 90%, ${adjustBrightness(accentColor, 0.1)}25 0%, transparent 40%),
      linear-gradient(135deg, ${color1} 0%, ${color2} 100%)
    `,
    blendMode: 'normal',
    opacity: 1
  }
};

// Helper to adjust color brightness
function adjustBrightness(hex, factor) {
  // Handle rgba colors
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) {
    return hex;
  }
  
  // Ensure hex format
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  
  const newR = Math.min(255, Math.max(0, Math.round(r + (255 - r) * factor)));
  const newG = Math.min(255, Math.max(0, Math.round(g + (255 - g) * factor)));
  const newB = Math.min(255, Math.max(0, Math.round(b + (255 - b) * factor)));
  
  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

// Get current header style settings
export function getHeaderStyleSettings() {
  const stored = localStorage.getItem('resume-header-style');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.warn('Failed to parse header style settings:', e);
    }
  }
  
  // Default settings
  return {
    type: 'gradient', // 'gradient', 'pattern', 'texture', 'image', 'solid'
    styleId: 'linear-135',
    customImage: null,
    imageOpacity: 0.3,
    imageFit: 'cover' // 'cover', 'contain', 'tile'
  };
}

// Save header style settings
export function saveHeaderStyleSettings(settings) {
  localStorage.setItem('resume-header-style', JSON.stringify(settings));
}

/**
 * Apply header style to the resume
 * @param {Object} settings - Header style settings
 * @param {Object} colors - Color palette { headerBg, headerBgEnd, accent }
 */
export function applyHeaderStyle(settings, colors) {
  const header = document.querySelector('.resume-header');
  if (!header) return;
  
  const { headerBg, headerBgEnd, accent } = colors;
  
  // Reset inline styles
  header.style.background = '';
  header.style.backgroundSize = '';
  header.style.backgroundPosition = '';
  
  // Remove any existing overlay
  const existingOverlay = header.querySelector('.header-texture-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }
  
  if (settings.type === 'solid') {
    header.style.background = headerBg;
  } else if (settings.type === 'gradient') {
    const gradient = GRADIENT_STYLES[settings.styleId];
    if (gradient) {
      header.style.background = gradient.css(headerBg, headerBgEnd);
    }
  } else if (settings.type === 'pattern') {
    const pattern = PATTERN_STYLES[settings.styleId];
    if (pattern) {
      header.style.background = pattern.css(headerBg, headerBgEnd, accent);
      if (pattern.size) {
        header.style.backgroundSize = pattern.size;
      }
      if (pattern.position) {
        header.style.backgroundPosition = pattern.position;
      }
    }
  } else if (settings.type === 'texture') {
    const texture = TEXTURE_STYLES[settings.styleId];
    if (texture) {
      if (texture.overlay) {
        // Create overlay for texture
        header.style.background = `linear-gradient(135deg, ${headerBg} 0%, ${headerBgEnd} 100%)`;
        const overlay = document.createElement('div');
        overlay.className = 'header-texture-overlay';
        overlay.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: ${texture.css(headerBg, headerBgEnd).split(',')[0]};
          mix-blend-mode: ${texture.blendMode};
          opacity: ${texture.opacity};
          pointer-events: none;
        `;
        header.appendChild(overlay);
      } else {
        header.style.background = texture.css(headerBg, headerBgEnd, accent);
      }
    }
  } else if (settings.type === 'image' && settings.customImage) {
    header.style.background = `
      linear-gradient(135deg, ${headerBg}${Math.round((1 - settings.imageOpacity) * 255).toString(16).padStart(2, '0')} 0%, ${headerBgEnd}${Math.round((1 - settings.imageOpacity) * 255).toString(16).padStart(2, '0')} 100%),
      url("${settings.customImage}")
    `;
    header.style.backgroundSize = settings.imageFit === 'tile' ? 'auto' : settings.imageFit;
    header.style.backgroundPosition = 'center';
    header.style.backgroundRepeat = settings.imageFit === 'tile' ? 'repeat' : 'no-repeat';
  }
}

/**
 * Generate preview thumbnail for a style
 * @param {string} type - 'gradient', 'pattern', 'texture'
 * @param {string} styleId - Style ID
 * @param {Object} colors - Color palette
 * @returns {string} CSS background value
 */
export function getStylePreview(type, styleId, colors) {
  const { headerBg, headerBgEnd, accent } = colors;
  
  if (type === 'gradient') {
    const gradient = GRADIENT_STYLES[styleId];
    return gradient ? gradient.css(headerBg, headerBgEnd) : '';
  } else if (type === 'pattern') {
    const pattern = PATTERN_STYLES[styleId];
    return pattern ? pattern.css(headerBg, headerBgEnd, accent) : '';
  } else if (type === 'texture') {
    const texture = TEXTURE_STYLES[styleId];
    return texture ? texture.css(headerBg, headerBgEnd, accent) : '';
  }
  
  return '';
}

/**
 * Initialize header style service
 */
export function initHeaderStyleService(colors) {
  const settings = getHeaderStyleSettings();
  applyHeaderStyle(settings, colors);
}
