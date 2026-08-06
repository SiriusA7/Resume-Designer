import tailwindcssAnimate from 'tailwindcss-animate';

/*
 * NOTE: the color values are inlined static strings (not built from a helper)
 * ON PURPOSE — the shadcn CLI parses this file with ts-morph to inject theme
 * tokens, and it cannot handle non-literal color values (a helper call breaks
 * its AST round-trip). Keep them as literal strings.
 *
 * Each token is expressed via color-mix with Tailwind's `<alpha-value>`
 * placeholder (substituted to 1 by default, 0.9 for `/90`, etc.) so shadcn's
 * `bg-primary/90`-style opacity modifiers actually apply — a plain `var(--x)`
 * color can't take an injected alpha channel in Tailwind v3. color-mix is the
 * same primitive styles/glass.css relies on, so no new browser baseline.
 */
/** @type {import('tailwindcss').Config} */
export default {
  // Reuse the [data-theme="dark"] attribute that src/theme.js already sets for
  // explicit dark mode. In "system" mode theme.js removes the attribute and
  // relies on the @media (prefers-color-scheme) fallback in main.css; shadcn
  // surfaces still theme there because every color maps onto a --color-* var the
  // existing cascade themes — so `dark:` utilities (rare in shadcn) are the only
  // thing not covered under system-dark. Accepted.
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './print.html', './src/**/*.{js,jsx}'],
  // Preflight (Tailwind's base reset) is ON — real shadcn components require it
  // for correct borders, box-sizing, and typography. Without it, browser-default
  // <button>/<input> chrome bleeds through and `border` utilities don't render.
  // The resume document (#resume) is a vanilla island styled by resume.css, and
  // the PDF renders via print.html (no Tailwind) — so neither the on-screen resume
  // nor PDF export depends on Preflight being off.
  theme: {
  	extend: {
  		colors: {
  			border: 'color-mix(in srgb, var(--border) calc(<alpha-value> * 100%), transparent)',
  			input: 'color-mix(in srgb, var(--input) calc(<alpha-value> * 100%), transparent)',
  			ring: 'color-mix(in srgb, var(--ring) calc(<alpha-value> * 100%), transparent)',
  			background: 'color-mix(in srgb, var(--background) calc(<alpha-value> * 100%), transparent)',
  			foreground: 'color-mix(in srgb, var(--foreground) calc(<alpha-value> * 100%), transparent)',
  			primary: {
  				DEFAULT: 'color-mix(in srgb, var(--primary) calc(<alpha-value> * 100%), transparent)',
  				foreground: 'color-mix(in srgb, var(--primary-foreground) calc(<alpha-value> * 100%), transparent)'
  			},
  			secondary: {
  				DEFAULT: 'color-mix(in srgb, var(--secondary) calc(<alpha-value> * 100%), transparent)',
  				foreground: 'color-mix(in srgb, var(--secondary-foreground) calc(<alpha-value> * 100%), transparent)'
  			},
  			destructive: {
  				DEFAULT: 'color-mix(in srgb, var(--destructive) calc(<alpha-value> * 100%), transparent)',
  				foreground: 'color-mix(in srgb, var(--destructive-foreground) calc(<alpha-value> * 100%), transparent)',
  				bg: 'color-mix(in srgb, var(--destructive-bg) calc(<alpha-value> * 100%), transparent)'
  			},
  			success: {
  				DEFAULT: 'color-mix(in srgb, var(--success) calc(<alpha-value> * 100%), transparent)',
  				bg: 'color-mix(in srgb, var(--success-bg) calc(<alpha-value> * 100%), transparent)'
  			},
  			warning: {
  				DEFAULT: 'color-mix(in srgb, var(--warning) calc(<alpha-value> * 100%), transparent)',
  				bg: 'color-mix(in srgb, var(--warning-bg) calc(<alpha-value> * 100%), transparent)'
  			},
  			muted: {
  				DEFAULT: 'color-mix(in srgb, var(--muted) calc(<alpha-value> * 100%), transparent)',
  				foreground: 'color-mix(in srgb, var(--muted-foreground) calc(<alpha-value> * 100%), transparent)'
  			},
  			accent: {
  				DEFAULT: 'color-mix(in srgb, var(--accent) calc(<alpha-value> * 100%), transparent)',
  				foreground: 'color-mix(in srgb, var(--accent-foreground) calc(<alpha-value> * 100%), transparent)'
  			},
  			popover: {
  				DEFAULT: 'color-mix(in srgb, var(--popover) calc(<alpha-value> * 100%), transparent)',
  				foreground: 'color-mix(in srgb, var(--popover-foreground) calc(<alpha-value> * 100%), transparent)'
  			},
  			card: {
  				DEFAULT: 'color-mix(in srgb, var(--card) calc(<alpha-value> * 100%), transparent)',
  				foreground: 'color-mix(in srgb, var(--card-foreground) calc(<alpha-value> * 100%), transparent)'
  			}
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		fontFamily: {
  			mono: 'var(--font-mono-ui)',
  			sans: 'var(--font-ui)'
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [tailwindcssAnimate],
};
